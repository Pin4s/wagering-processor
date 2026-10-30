# Wagering Processor

Serviço financeiro que processa transações de apostas (BET, WIN, LOSS, REFUND, ROLLBACK)
enviadas por provedores de jogos, via HTTP ou fila SQS, mantendo saldo, ledger imutável e
idempotência corretos com várias instâncias rodando ao mesmo tempo.

Desafio técnico Jungle Gaming. Stack: NestJS · Bun · TypeScript (strict) · PostgreSQL ·
MikroORM · SQS (LocalStack) · Docker Compose.

**Decisões de arquitetura, trade-offs e limitações:** [ARCHITECTURE.md](./ARCHITECTURE.md)

---

## Requisitos

- [Bun](https://bun.sh) 1.x (desenvolvido com 1.4.4)
- Docker e Docker Compose v2
- Um token do LocalStack (`LOCALSTACK_AUTH_TOKEN`)

## Como rodar

```bash
# 1. Clonar o repositório
git clone https://github.com/Pin4s/wagering-processor
cd wagering-processor

# 2. Variáveis de ambiente
cp .env.example .env
# Edite o .env e preencha LOCALSTACK_AUTH_TOKEN. Os demais valores já funcionam localmente.

# 3. Infraestrutura (Postgres + LocalStack). As filas SQS são criadas automaticamente.
#    O --wait só retorna quando os dois estiverem prontos (healthchecks).
docker compose up -d --wait

# 4. Dependências
bun install

# 5. Banco: aplica todas as migrations
bun run migrate:up

# 6. Aplicação (porta 3000)
bun run start
```

Conferir se está tudo de pé:

```bash
curl localhost:3000/health/ready
# {"status":"ok","checks":{"postgres":"ok","sqs":"ok"}}
```

> A aplicação precisa do Postgres e do LocalStack de pé. Se algum estiver fora, ela não cai:
> tenta reconectar com espera crescente e `/health/ready` responde 503 até voltar.

Cada instância da aplicação roda, além da API HTTP, três processos de fundo: o **consumer**
da fila de transações, o **publisher** da outbox e o **worker** de transações com referência
pendente. Para simular várias instâncias, suba mais processos com `PORT` diferente.

## Testes

Todos usam **Postgres e LocalStack reais** (nenhum mock de banco ou fila), mas num **banco e
filas próprios** (`wagering_test` e `test-*`). Os testes não apagam os dados de
desenvolvimento e podem rodar com a aplicação ligada.

```bash
bun run test:unit   # regras de domínio (Money, Wallet, ledger, transações), sem infraestrutura
bun run test:int    # integração: banco, SQS, idempotência, concorrência, outbox, inbox, DLQ
bun run test:e2e    # 3 processos reais da aplicação, com kill forçado e restart (~35 s)
```

> Se você já tinha o volume do Postgres de uma versão anterior deste projeto, rode
> `docker compose down -v` uma vez: o banco de testes só é criado na primeira inicialização.

Os 8 cenários de concorrência pedidos no desafio estão cobertos (ver a seção de testes do
[ARCHITECTURE.md](./ARCHITECTURE.md)). Todo teste de integração termina conferindo a
invariante `saldo da wallet == saldo reconstruído pelo ledger`.

---

## API

Corpo de erro padrão: `{ "error": "<CÓDIGO>", "message": "<texto>" }`.

| Método | Rota | Descrição |
|---|---|---|
| `POST` | `/wallets` | Cria wallet (saldo inicial > 0 gera transação `OPENING` + lançamento) |
| `GET` | `/wallets/:walletId` | Saldo e versão atuais |
| `GET` | `/wallets/:walletId/ledger?cursor=&limit=` | Extrato paginado (cursor opaco, `limit` 1–100, padrão 50) |
| `POST` | `/wallets/:walletId/reconciliation` | Compara saldo gravado com o ledger; não corrige divergências |
| `POST` | `/wagering/transactions` | Submete transação (header `Idempotency-Key` obrigatório) |
| `GET` | `/wagering/transactions/:transactionId` | Consulta por id interno |
| `GET` | `/providers/:providerId/wagering/transactions/:externalTransactionId` | Consulta pelo id do provedor |
| `GET` | `/health/live` | Processo vivo |
| `GET` | `/health/ready` | Postgres e SQS alcançáveis |
| `GET` | `/metrics` | Métricas no formato Prometheus |

### Exemplo: submeter uma aposta

```bash
curl -i -X POST localhost:3000/wagering/transactions \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: provider-a:transaction-123' \
  -d '{
    "providerId": "provider-a",
    "externalTransactionId": "transaction-123",
    "playerId": "<PLAYER_ID>",
    "walletId": "<WALLET_ID>",
    "roundId": "round-987",
    "gameId": "fortune-chimp",
    "kind": "BET",
    "money": { "amount": "25.00", "currency": "BRL" }
  }'
```

```json
{
  "transactionId": "…",
  "status": "PROCESSED",
  "balance": { "amount": "975.00", "currency": "BRL" },
  "idempotentReplay": false
}
```

O header opcional `X-Correlation-Id` é propagado para logs e eventos (gerado se ausente) e
devolvido na resposta.

### Status HTTP de `POST /wagering/transactions`

| Situação | Status | `error` / `status` | O provedor deve |
|---|---|---|---|
| Aplicada (nova ou replay) | 200 | `PROCESSED` | seguir |
| Aceita, aguardando a referência | 202 | `PENDING_REFERENCE` | aguardar (reprocessada automaticamente) |
| Payload inválido | 400 | `INVALID_PAYLOAD` | corrigir o payload |
| Sem header `Idempotency-Key` | 400 | `MISSING_IDEMPOTENCY_KEY` | enviar o header |
| Wallet inexistente | 404 | `WALLET_NOT_FOUND` | corrigir o `walletId` |
| Mesma key com payload diferente | 409 | `IDEMPOTENCY_CONFLICT` | não reenviar (é outro pedido) |
| Recusada por regra de negócio | 422 | `REJECTED` + `failureCode` | decidir pelo `failureCode` |
| Jogador ou moeda não conferem com a wallet | 422 | `WALLET_MISMATCH` | corrigir o payload |
| Falha transitória (banco, deadlock, timeout) | 503 | `TEMPORARILY_UNAVAILABLE` | **reenviar com a mesma key** |

Um replay devolve o mesmo status e o mesmo corpo do resultado original, incluindo o saldo
daquele momento. A taxonomia de `failureCode` está no [ARCHITECTURE.md](./ARCHITECTURE.md).

---

## Mensageria (SQS)

| Fila | Papel |
|---|---|
| `wager-transactions.fifo` | entrada: transações enviadas pelos provedores |
| `wager-transactions-dlq.fifo` | mensagens inválidas ou que falharam 5 vezes |
| `wagering-events.fifo` | saída: eventos de integração publicados pela outbox |

Os testes usam filas equivalentes com o prefixo `test-`, criadas pelo mesmo script.

Enviar uma transação pela fila (formato da seção 10 do desafio):

```bash
# 1. Descobrir a URL da fila
docker compose exec localstack awslocal sqs get-queue-url --queue-name wager-transactions.fifo

# 2. Enviar (troque <QUEUE_URL>, <PLAYER_ID> e <WALLET_ID>)
docker compose exec localstack awslocal sqs send-message \
  --queue-url <QUEUE_URL> \
  --message-group-id <WALLET_ID> \
  --message-deduplication-id msg-123 \
  --message-body '{"messageId":"msg-123","type":"WagerTransactionRequested","occurredAt":"2026-10-30T12:00:00.000Z","data":{"providerId":"provider-a","externalTransactionId":"transaction-456","idempotencyKey":"provider-a:transaction-456","playerId":"<PLAYER_ID>","walletId":"<WALLET_ID>","roundId":"round-987","gameId":"fortune-chimp","kind":"BET","money":{"amount":"25.00","currency":"BRL"}}}'
```

Ler os eventos publicados:

```bash
docker compose exec localstack awslocal sqs get-queue-url --queue-name wagering-events.fifo
docker compose exec localstack awslocal sqs receive-message --queue-url <EVENTS_QUEUE_URL> --max-number-of-messages 10
```

## Observabilidade

- **Logs** em JSON, uma linha por evento, com `correlationId`, `messageId`, `transactionId`,
  `walletId` e `providerId` quando aplicável. Sem valores monetários nem payloads completos.
- **Métricas** em `GET /metrics` (formato Prometheus): transações por status, duplicatas
  detectadas, retries, mensagens em DLQ, espera e erros de lock, outbox pendente e lag,
  latência de processamento, divergências de reconciliação.
- **Health:** `/health/live` (processo) e `/health/ready` (Postgres + SQS).

---

## Variáveis de ambiente

Todas estão no `.env.example` com valores que funcionam localmente.

| Variável | Para quê |
|---|---|
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `DATABASE_URL` | Postgres |
| `LOCALSTACK_AUTH_TOKEN` | token do LocalStack (obrigatório preencher) |
| `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `SQS_ENDPOINT` | cliente SQS apontando para o LocalStack |
| `SQS_WAGER_TRANSACTIONS_QUEUE`, `SQS_WAGER_TRANSACTIONS_DLQ`, `SQS_EVENTS_QUEUE` | nomes das filas |
| `OUTBOX_PUBLISHER_ENABLED`, `OUTBOX_POLL_INTERVAL_MS` | publisher da outbox |
| `SQS_CONSUMER_ENABLED`, `CONSUMER_RETRY_BASE_SECONDS` | consumer da fila de transações |
| `PENDING_REFERENCE_WORKER_ENABLED`, `PENDING_REFERENCE_POLL_INTERVAL_MS`, `PENDING_REFERENCE_MAX_ATTEMPTS`, `PENDING_REFERENCE_RETRY_BASE_SECONDS` | worker de referências pendentes |
| `TEST_DATABASE_URL` | banco usado pelos testes (`wagering_test`); obrigatório para `bun test` |
| `PORT` | porta HTTP (padrão 3000) |

## Estrutura

```
src/
  shared/            Money, ids, logger JSON, métricas, utilidades HTTP
  modules/
    wallet/          domain · application · infrastructure · http
    wagering/        domain · application (use case, worker) · infrastructure · http
    messaging/       eventos, outbox, inbox, publisher, consumer SQS
migrations/          migrations geradas pelo MikroORM (todas reversíveis)
localstack/          script que cria as filas (de dev e de teste) na subida do LocalStack
postgres/init/       script que cria o banco de testes na primeira subida do Postgres
test/preload.ts      aponta os testes para o banco e as filas de teste
test/integration/    testes com Postgres e LocalStack reais
test/e2e/            teste com 3 processos da aplicação
```

## Comandos úteis

| Comando | O que faz |
|---|---|
| `bun run start` | sobe a aplicação |
| `bun run migrate:up` | aplica as migrations pendentes |
| `bun run migrate:down` | desfaz a última migration |
| `bun run migrate:create` | gera uma migration a partir das entidades |
| `docker compose down` | para a infraestrutura (mantém os dados) |
| `docker compose down -v` | para e **apaga** os dados do Postgres |