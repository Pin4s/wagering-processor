# Arquitetura

Decisões técnicas, trade-offs e limitações do Wagering Processor. Cada seção indica qual
parte do enunciado ela atende e segue o formato **Decisão → Por quê → Trade-off**.
Setup e comandos estão no [README.md](./README.md).

## Índice

- [Arquitetura](#arquitetura)
  - [Índice](#índice)
  - [1. Visão geral](#1-visão-geral)
  - [2. Autenticação](#2-autenticação)
  - [3. Stack, ORM e estratégia transacional](#3-stack-orm-e-estratégia-transacional)
    - [Bun + NestJS](#bun--nestjs)
    - [MikroORM v7](#mikroorm-v7)
    - [Entidades separadas do domínio](#entidades-separadas-do-domínio)
    - [Migrations geradas e reversíveis](#migrations-geradas-e-reversíveis)
    - [Estratégia transacional](#estratégia-transacional)
  - [4. Money e persistência do dinheiro](#4-money-e-persistência-do-dinheiro)
  - [5. Modelo de domínio e transições](#5-modelo-de-domínio-e-transições)
    - [Transições válidas da `WagerTransaction`](#transições-válidas-da-wagertransaction)
  - [6. Garantias no schema do banco](#6-garantias-no-schema-do-banco)
  - [7. Regras de negócio e interpretações](#7-regras-de-negócio-e-interpretações)
    - [⚠ Interpretação da regra 4: uma operação só pode ser estornada UMA vez](#-interpretação-da-regra-4-uma-operação-só-pode-ser-estornada-uma-vez)
    - [Outras interpretações](#outras-interpretações)
  - [8. Referências fora de ordem (PENDING\_REFERENCE)](#8-referências-fora-de-ordem-pending_reference)
  - [9. Códigos de falha](#9-códigos-de-falha)
  - [10. Concorrência](#10-concorrência)
  - [11. Idempotência e API HTTP](#11-idempotência-e-api-http)
    - [Status HTTP](#status-http)
  - [12. Consumo por SQS](#12-consumo-por-sqs)
  - [13. Transactional outbox e eventos](#13-transactional-outbox-e-eventos)
  - [14. Observabilidade](#14-observabilidade)
  - [15. Testes](#15-testes)
    - [Os 8 cenários de concorrência](#os-8-cenários-de-concorrência)
  - [16. Trade-offs e limitações](#16-trade-offs-e-limitações)

---

## 1. Visão geral

```
 Provedor ──HTTP──▶ WageringController ─┐
                                        ├─▶ ProcessWagerTransactionUseCase
 Provedor ──SQS───▶ WagerTransactions   │      (mesmo caso de uso nas duas entradas)
  wager-transactions.fifo   Consumer ───┘
                                               BEGIN
                                                 SELECT wallet ... FOR UPDATE      (lock por wallet)
                                                 idempotência / inbox
                                                 regra de negócio (domínio puro)
                                                 INSERT transação, lançamento, outbox, inbox
                                                 UPDATE wallet
                                               COMMIT  ◀── tudo ou nada
                                                    │
                     OutboxPublisher ◀── outbox_messages (FOR UPDATE SKIP LOCKED)
                            │
                            ▼
                  wagering-events.fifo ──▶ sistemas externos

 PendingReferenceWorker: reprocessa transações PENDING_REFERENCE com backoff.
```

Cada instância roda a API HTTP e três loops de fundo: consumer, publisher da outbox e worker
de referências pendentes. A **correção financeira e de estado** vem do PostgreSQL (locks,
constraints, transações), e não da memória da aplicação, por isso não depende de quantas
instâncias estão rodando. A **entrega das mensagens** vem do SQS (visibilidade, retries,
DLQ) e pode repetir, tanto na entrada quanto na saída. As seções 12 e 13 explicam como cada
duplicata é tratada.

**Organização do código:** um módulo por funcionalidade (`wallet`, `wagering`, `messaging`),
com `domain/` (regras em TypeScript puro, sem Nest nem ORM), `application/` (casos de uso e
workers), `infrastructure/` (entidades, mappers, SQS) e, em `wallet` e `wagering`, `http/`
(controllers). A separação é de organização, não uma arquitetura hexagonal estrita: a camada
de aplicação usa o `EntityManager`, as entidades e os mappers diretamente (seção 3). O
isolamento rigoroso fica no `domain/`, que não depende de Nest nem do ORM.

---

## 2. Autenticação

> Atende: enunciado §2

**Decisão:** autenticação não foi implementada. O ponto de extensão é um `AuthGuard` no-op
(`src/shared/http/auth.guard.ts`), aplicado aos controllers de wallet e de wagering (submissão e consultas). `/health/*`
e `/metrics` ficam abertos.

**Por quê:** autenticação não pontua no desafio, e o tempo foi priorizado para correção
financeira, concorrência e idempotência.

**Desenho que eu adotaria:** um Identity Provider externo (Keycloak ou Zitadel) emitindo
tokens OIDC via *client credentials*, um client por provedor de jogos. O guard valida o JWT
(assinatura, emissor, expiração) e extrai o identificador do provedor de uma claim. Esse
`providerId` autenticado passa a ser a fonte da verdade e precisa conferir com o `providerId`
do corpo, senão a requisição é recusada. Mensagens do SQS são tratadas como canal interno
confiável, mas o `providerId` delas continua sujeito às mesmas validações de domínio.

---

## 3. Stack, ORM e estratégia transacional

> Atende: enunciado §4

### Bun + NestJS

**Decisão:** projeto montado com `bun init` e só os pacotes que o Nest precisa, com o Bun
como runtime, gerenciador de pacotes e test runner. Adaptador HTTP: Express, o padrão do Nest.
**Por quê:** começar enxuto. O custo de cada requisição está no banco (transação e lock da
wallet), não no adaptador. Não foi medido (não há teste de carga).

### MikroORM v7

**Decisão:** MikroORM (o preferencial do enunciado), com `ReflectMetadataProvider`.
**Por quê:** Unit of Work, Identity Map, `em.transactional()` e `LockMode` são exatamente as
ferramentas que o problema pede. O metadata provider lê os tipos das entidades via
`emitDecoratorMetadata` (já ligado no `tsconfig` para os decorators do Nest). Na injeção de
dependência, os serviços usam `@Inject(...)` explícito, para não depender do runtime emitir
metadata de tipo.

### Entidades separadas do domínio

**Decisão:** as classes de domínio (`Wallet`, `WagerTransaction`...) não têm decorators. As
entidades do ORM (`*.entity.ts`, em `infrastructure/`) descrevem as tabelas e suas
constraints, e mappers (funções simples) traduzem entre os dois: `toXDomain` para ler (usa
`rehydrate`), `toNewXEntity` para criar (INSERT) e `updateXEntity` para atualizar a entidade
já carregada (UPDATE; o Unit of Work grava só o que mudou). O ledger não tem mapper de
atualização: é append-only, e o banco rejeita `UPDATE` e `DELETE` por trigger.
**Por quê:** o enunciado (§6.1) proíbe o domínio de depender do ORM, e assim as regras são
testadas sem banco.
**Trade-off:** um mapper por agregado; mais código que usar a entidade direto.

### Migrations geradas e reversíveis

**Decisão:** o schema vem das entidades; `bun run migrate:create` gera a migration por diff
(com `down()`), e `src/migrate.ts` aplica ou desfaz por código. A v7 gera pelos decorators as
`unique`, `check`, chaves estrangeiras, índices parciais (`expression`) e o trigger do ledger
(`@Trigger`). O snapshot (`migrations/.snapshot-wagering.json`) é versionado.
Toda migration gerada foi revisada antes de aplicar e testada com `down` e `up`.
**Trade-off:** o gerador não detecta mudança no SQL de um índice definido por `expression`,
só no nome. Para alterar um desses índices, troca-se o nome.

### Estratégia transacional

**Decisão:** uma operação = um `em.transactional`. Dentro dele: lock da wallet, checagem de
idempotência, regra de negócio, e a gravação da transação, do lançamento, do saldo, dos
eventos (outbox) e, quando vem do SQS, da inbox. Um único `COMMIT` no fim.
**Por quê:** com um único commit, saldo, ledger, eventos e deduplicação não ficam
inconsistentes entre si, inclusive se o processo morrer no meio.
**Trade-off:** os casos de uso usam o `EntityManager` direto, sem uma porta de repositório.
É menos abstrato, mas bem mais simples; o domínio continua puro.

---

## 4. Money e persistência do dinheiro

> Atende: enunciado §5 (restrição 1) e §6.1

**Decisão:** `Money` guarda o valor como `bigint` em **centavos** (`"25.50"` → `2550n`), com
construtor privado e factories (`from`, `fromCents`, `zero`). É imutável: toda operação
devolve uma nova instância. Nos contratos (API, eventos, SQS) o dinheiro trafega como string
decimal com 2 casas (`{ "amount": "25.50", "currency": "BRL" }`). No banco, colunas `bigint`
com sufixo `_cents` (`balance_cents`, `amount_cents`...) e a moeda em `char(3)`.

**Por quê:** inteiro é exato (nada de `0.1 + 0.2`), não precisa de biblioteca de decimal e é
um formato familiar para dinheiro em banco. `fromCents`/`toCents` existem só para conversar
com o banco; para fora o dinheiro sempre sai como string.

**Validação de entrada** (`Money.from`): aceita 0 a 2 casas e normaliza (`"25"` →
`"25.00"`); rejeita mais de 2 casas, sinal, notação científica, `NaN`, `Infinity`, vírgula,
espaços e string vazia. A moeda é validada pelo formato ISO-4217 (3 letras maiúsculas), sem
lista de códigos. Operações entre moedas diferentes lançam `CurrencyMismatchError`;
`equals` com moedas diferentes devolve `false`.

**Trade-off:** no `psql`, `2550` exige lembrar que é centavo (mitigado pelo sufixo `_cents`).
O modelo é multi-moeda: os testes de unidade cobrem outras moedas e o conflito entre moedas;
os de integração e o e2e usam só BRL (permitido pelo enunciado).

---

## 5. Modelo de domínio e transições

> Atende: enunciado §6

As entidades de domínio (`Money`, `Wallet`, `WalletLedgerEntry`, `WagerTransaction`,
`OutboxMessage`, `InboxMessage`) têm construtor privado e duas portas de entrada: uma para
objeto **novo** (`from`, `open`, `create`, `enqueue`, `receive`) e `rehydrate` para objeto
**já persistido** (reconstrói sem revalidar). Os eventos de integração têm construtor
protegido e só são criados pelas factories `from` das subclasses (não são reidratados).

- **`Wallet`:** o saldo (`_balance`) é privado, só com getter. `credit` e `debit` são o único
  caminho que altera o saldo, e **sempre devolvem o `WalletLedgerEntry`**: é impossível mudar
  o saldo sem gerar lançamento. Validam tudo antes de alterar o estado (tudo ou nada).
  `debit` lança `InsufficientBalanceError` se o saldo for menor que o valor (saldo igual é
  permitido). `version` nasce em 1 e só sobe quando o saldo muda. `open` devolve a wallet
  e, se o saldo inicial for maior que zero, o lançamento de abertura (CREDIT de 0 até o saldo).
- **`WalletLedgerEntry`:** todos os campos `readonly`, sem métodos de mudança. `create` valida
  valor positivo e `saldoAntes ± valor = saldoDepois` (`isBalanced`). O sentido vem do
  `direction`, nunca do sinal.
- **`WagerTransaction`:** registra o pedido do provedor e o resultado. Além dos campos do
  esqueleto, guarda `observedBalance` (o saldo ao finalizar), que é o que o replay devolve
  (regra 7), já que LOSS e REJECTED não têm lançamento.
- **`IntegrationEvent`** (abstrata) + 4 subclasses, **`OutboxMessage`** e **`InboxMessage`**:
  ver seções 12 e 13.

### Transições válidas da `WagerTransaction`

```
PENDING            → PENDING_REFERENCE | PROCESSED | REJECTED | FAILED
PENDING_REFERENCE  → PROCESSED | REJECTED | FAILED
PROCESSED, REJECTED, FAILED → (terminais: nenhuma transição)
```

Toda transição checa primeiro se o estado é terminal; se for, lança
`InvalidTransactionStateError` (erro de programação, não caminho de negócio). `REJECTED` é
recusa por regra de negócio. `FAILED` está previsto no domínio para erro permanente de
infraestrutura, mas nenhum fluxo atual o produz: falhas de infraestrutura fazem rollback e
nada é gravado (HTTP 503 ou retry no SQS).

**Sentido no ledger** (`ledgerDirectionFor`): BET = débito; WIN, REFUND e OPENING = crédito;
ROLLBACK = inverso da transação referenciada; LOSS não gera lançamento.

---

## 6. Garantias no schema do banco

> Atende: enunciado §5, restrição 9 (unicidade, imutabilidade e não-negatividade no schema)

| Tabela | Garantia no banco | Para quê |
|---|---|---|
| `wallets` | `UNIQUE (player_id, currency)` | uma wallet por jogador e moeda |
| | `CHECK (balance_cents >= 0)` | saldo nunca negativo, mesmo se o código errar |
| `wager_transactions` | `UNIQUE (idempotency_key)` | **idempotência persistente** |
| | `UNIQUE (provider_id, external_transaction_id)` | sem duplicata por provedor; base da busca de referência |
| | índice único parcial em `reference_transaction_id` `WHERE kind IN ('REFUND','ROLLBACK')` | cada transação estornada no máximo uma vez (seção 7) |
| | `CHECK` de `kind`, `status` e `failure_code` (enums); `CHECK (amount_cents >= 0)`; FK para `wallets` e auto-FK da referência | valores válidos e integridade |
| `wallet_ledger_entries` | **trigger `BEFORE UPDATE OR DELETE`** que lança erro | **ledger append-only** |
| | `UNIQUE (wallet_id, transaction_id)` | uma transação gera no máximo um lançamento por wallet |
| | `CHECK (amount_cents > 0)`, saldos `>= 0` e `CHECK` da aritmética (`antes ± valor = depois`) | lançamento auditável |
| | índice `(wallet_id, created_at, id)` | paginação do extrato por cursor |
| `outbox_messages` | índice parcial em `occurred_at` `WHERE published_at IS NULL` | o publisher acha só as pendentes |
| `inbox_messages` | `PRIMARY KEY (consumer_name, message_id)` | deduplicação persistente de mensagens |

`TRUNCATE` não é bloqueado pelo trigger: é uma operação administrativa, que a aplicação nunca
executa.

---

## 7. Regras de negócio e interpretações

> Atende: enunciado §7 ("Qualquer interpretação adicional adotada deve ser documentada")

As regras 1 a 9 estão implementadas no caso de uso e testadas com Postgres real. Para um
REFUND ou ROLLBACK, a referência é buscada por `(providerId, referenceExternalTransactionId)`.
Se ela não existe, ou se ela própria está `PENDING_REFERENCE`, o estorno fica pendente
(seção 8). Senão, é conferido nesta ordem: tipo permitido (regra 3) → mesmo jogador, wallet,
moeda e rodada (regra 2) → referência `PROCESSED` → mesmo valor (regra 5) → ainda não
estornada (regra 4) → saldo suficiente, se o estorno debita (regra 9). Toda recusa fica
gravada como `REJECTED`.

### ⚠ Interpretação da regra 4: uma operação só pode ser estornada UMA vez

A regra 4 diz: *"Uma referência não pode ser revertida duas vezes **pelo mesmo tipo** de
operação"*. Lida ao pé da letra, ela permite REFUND **e** ROLLBACK da mesma operação, porque
os tipos são diferentes:

```
saldo 100 → BET 20 (#123) → 80 → REFUND #123 → 100 → ROLLBACK #123 → 120
```

O jogador apostou 20 e recebeu 40: **crédito duplicado**, proibido pela invariante global
(§3) e eliminatório (§14). O enunciado não proíbe esse caso de forma explícita.

**Decisão:** cada operação pode receber **no máximo um estorno aplicado**, de qualquer tipo.
O segundo vira `REJECTED` com `ALREADY_REVERSED`. Isso cumpre a regra 4 (é mais restrito que
ela) e preserva o fluxo previsto pela regra 3 de desfazer um estorno: um ROLLBACK **de um
REFUND** continua permitido, porque aponta para outra operação (o REFUND), não para a aposta. Garantido em duas camadas:
checagem no caso de uso + índice único parcial no banco.

### Outras interpretações

- **Valor zero só é aceito em LOSS.** Um WIN de zero geraria um lançamento de zero, que o
  ledger recusa.
- **`OPENING` é interno:** recusado pela API e pela fila (400 / DLQ). Gerado só na abertura de
  wallet, com `providerId = 'internal'` e `externalTransactionId = 'opening:<walletId>'`.
- **Wallet inexistente ou que não confere** (outro jogador ou moeda): erro direto, **sem
  gravar a transação** (a tabela de transações tem FK para a wallet). Nada é reservado para a
  key: reenviar o mesmo pedido dá o mesmo erro enquanto a situação da wallet não mudar, e
  nenhum efeito é duplicado.
- **Referência que também está `PENDING_REFERENCE`** (ex.: ROLLBACK de um REFUND que espera a
  BET): a nova transação também fica pendente e é resolvida em cadeia pelo worker.
- **Referência `REJECTED`/`FAILED`:** o estorno é recusado com `REFERENCE_NOT_PROCESSED`.
- **Resposta de transação pendente** mostra o status e o saldo **atuais** (ela ainda não
  terminou, e o worker pode resolvê-la); transações terminadas (`PROCESSED`/`REJECTED`)
  mostram o resultado e o saldo **daquele momento** (regra 7).

---

## 8. Referências fora de ordem (PENDING_REFERENCE)

> Atende: enunciado §7.1

**Decisão:** referência ausente → a transação é gravada como `PENDING_REFERENCE`, sem mexer
no saldo, e um evento `WagerTransactionPendingReference` é publicado. O
`PendingReferenceWorker` roda em cada instância (por padrão, 2 s depois de cada rodada,
configurável) e pega até 10 pendentes que já estão "na hora", das mais antigas para as mais
novas. Para cada uma, numa transação própria: trava a **wallet** (mesmo lock e mesma ordem do
caso de uso, o que evita inversão de locks com as apostas), relê a transação (se outra
instância já resolveu, pula) e reaplica a mesma regra de estorno.

**Limite:** 10 tentativas, com espera de 1 s, 2 s, 4 s... entre elas (cerca de 8,5 minutos no
total). Esgotado o limite (a referência não chegou, ou continuou ela mesma pendente):
`REJECTED` com `REFERENCE_NOT_FOUND` e evento `WagerTransactionRejected`. Uma referência que
chegue depois disso não reabre a transação. Limite, espera e intervalo são configuráveis por variável de
ambiente.

**Por quê:** é uma decisão de prazo: dar alguns minutos para mensagens fora de ordem
chegarem, sem prender a transação indefinidamente nem atrasar a resposta definitiva para o
provedor.

**Trade-off:** o contador de tentativas (`reference_attempts`, `next_reference_check_at`)
fica só na entidade, como detalhe operacional. Se uma pendente der erro, o resto daquele lote
espera a próxima rodada (nada fica pela metade, porque cada uma tem sua transação); um erro
persistente na primeira candidata atrasa as demais.

---

## 9. Códigos de falha

> Atende: enunciado §7.2

| `failureCode` | Origem | O provedor deve |
|---|---|---|
| `INSUFFICIENT_FUNDS` | BET sem saldo | desistir desta aposta |
| `REVERSAL_INSUFFICIENT_FUNDS` | estorno deixaria o saldo negativo (regra 9) | não reenviar; tratar fora do sistema |
| `REFERENCE_NOT_FOUND` | referência não chegou (ou continuou pendente) no prazo (§7.1) | verificar se enviou a transação referenciada |
| `REFERENCE_MISMATCH` | referência de outro jogador, wallet, moeda ou rodada (regra 2) | corrigir o payload |
| `INVALID_REFERENCE_KIND` | REFUND fora de BET; ROLLBACK fora de BET/WIN/REFUND (regra 3) | corrigir o payload |
| `REFERENCE_NOT_PROCESSED` | referência existe, mas não foi aplicada | desistir do estorno |
| `ALREADY_REVERSED` | operação já estornada (regra 4, seção 7) | desistir (duplicidade de negócio) |
| `AMOUNT_MISMATCH` | valor diferente da referência (regra 5) | corrigir o payload |
| `WALLET_NOT_FOUND` / `WALLET_MISMATCH` | wallet inexistente / não confere | corrigir o payload |
| `INTERNAL_ERROR` | reservado para `FAILED` (não produzido hoje, seção 5) | problema nosso; acionar suporte |

`REJECTED` é terminal: reenviar a mesma `Idempotency-Key` devolve o mesmo resultado. Para
tentar de novo, o provedor precisa de um `externalTransactionId` novo. Os enums viram `CHECK`
no banco, então um código novo exige migration.

---

## 10. Concorrência

> Atende: enunciado §8

**Decisão:** **lock pessimista por wallet.** Dentro do `em.transactional`, a wallet é lida com
`LockMode.PESSIMISTIC_WRITE` (`SELECT ... FOR UPDATE`). Outra operação na mesma wallet
espera até o commit; wallets diferentes seguem em paralelo.

**Por quê:**
- vale entre instâncias, porque o lock é do Postgres, não da memória da aplicação;
- serializa só o que precisa ser serializado (uma wallet), sem lock global (restrição 6);
- não precisa de laço de retry.

| Alternativa | Por que não |
|---|---|
| Lock otimista (`version`) | exige retry com limite; numa wallet disputada, muitas tentativas falham |
| Update atômico condicionado | resolve o débito, mas idempotência e regras de estorno também precisam ler antes |
| Advisory lock | mesma ideia do pessimista, menos explícita |
| FIFO do SQS por wallet | otimização, não garantia (§8), e não cobre o HTTP |

**Idempotência dentro do lock:** a busca pela `Idempotency-Key` acontece **depois** de obter
o lock. Com 50 pedidos iguais simultâneos, só o primeiro vê "não existe"; os outros 49, ao
conseguir o lock, já enxergam a transação gravada e devolvem replay.

**Defesa em camadas:** as `UNIQUE` do banco são a rede de segurança. Se duas gravações
escaparem do lock, o banco recusa a segunda, e `resolveDuplicate` relê a vencedora e
responde replay ou conflito.

**O teste do teste:** a primeira versão dos testes paralelos **passava mesmo sem o lock**
(o pool de conexões abria conexão sob demanda, e as operações nunca se sobrepunham). Os
testes foram reforçados com um teste **determinístico**: outra transação segura o
`FOR UPDATE`, e a aposta precisa esperar e enxergar o saldo novo. Na verificação feita
durante o desenvolvimento, com o lock removido, três testes de concorrência falharam em todas
as rodadas executadas; com o lock, todos passaram.

**Trade-off:** numa wallet muito disputada (hot wallet) as operações fazem fila. É
justamente a serialização que a correção exige; a espera é medida pela métrica
`wallet_lock_wait_seconds`.

---

## 11. Idempotência e API HTTP

> Atende: enunciado §9

**Decisão:** o header `Idempotency-Key` é obrigatório e é a fonte da verdade. O
`payloadHash` identifica o **conteúdo** do pedido:

- **Algoritmo:** SHA-256 (hexadecimal) de um JSON com as chaves em ordem alfabética, escrito
  explicitamente, com os campos de negócio: `externalTransactionId`, `gameId`, `kind`,
  `money` (normalizado para 2 casas), `playerId`, `providerId`,
  `referenceExternalTransactionId` (omitido quando ausente), `roundId`, `walletId`.
- **Não entram:** o header `Idempotency-Key`, o `idempotencyKey` da mensagem SQS e metadados
  de transporte. `"25"` e `"25.00"` geram o mesmo hash.

| Situação | Resultado |
|---|---|
| Key nova | processa |
| Mesma key, mesmo hash | **replay**: o resultado gravado, `idempotentReplay: true`, sem efeito financeiro nem evento novo (pelo SQS, só a inbox registra o novo `messageId`) |
| Mesma key, hash diferente | **409 `IDEMPOTENCY_CONFLICT`** (conflito, não replay), desde que a wallet do pedido exista; caso contrário, 404 |
| Key nova, mas `(providerId, externalTransactionId)` já usado | 409 `IDEMPOTENCY_CONFLICT` |

### Status HTTP

Mapeamento consistente, que distingue os cinco casos exigidos (payload inválido, conflito,
rejeição de negócio, aceite pendente e falha transitória). Erros de validação, conflito e
infraestrutura usam o corpo `{ "error", "message" }`; uma recusa de negócio (422 `REJECTED`)
devolve o próprio resultado da transação (`transactionId`, `status`, `failureCode`,
`balance`).

| Situação | Status |
|---|---|
| Aplicada (nova ou replay) | 200 `PROCESSED` |
| Aceita, aguardando referência | 202 `PENDING_REFERENCE` |
| Payload inválido / sem `Idempotency-Key` | 400 `INVALID_PAYLOAD` / `MISSING_IDEMPOTENCY_KEY` |
| Wallet inexistente | 404 `WALLET_NOT_FOUND` |
| Conflito de idempotência | 409 `IDEMPOTENCY_CONFLICT` |
| Recusa por regra de negócio | 422 `REJECTED` + `failureCode` |
| Jogador ou moeda não conferem | 422 `WALLET_MISMATCH` |
| Banco fora, deadlock, timeout de lock | 503 `TEMPORARILY_UNAVAILABLE` |

**Só o 503 significa "reenvie igual".** Verificado manualmente durante o desenvolvimento:
com o Postgres parado o POST responde 503 e nada é gravado; o mesmo pedido, reenviado depois,
é processado normalmente. Na criação de wallet: 201, 400 `INVALID_PAYLOAD` e 409 `WALLET_ALREADY_EXISTS`.

**Validação de payload:** escrita à mão, sem `class-validator` (poucos campos, tudo
explícito). O corpo é tipado com campos `unknown` e checado campo a campo; a mesma função
valida o HTTP e as mensagens do SQS.

**Extrato:** `GET /wallets/:id/ledger` usa paginação por *keyset* em `(created_at, id)`, com
cursor opaco (base64url). Diferente de páginas numeradas, a ordem é estável e um lançamento
nunca aparece duas vezes; lançamentos gravados durante a leitura entram conforme a sua
posição nessa ordem (`created_at` vem do relógio de cada instância).

**Reconciliação:** numa transação, trava a wallet com `FOR SHARE`, lê o saldo gravado e
calcula o saldo pelo ledger com SQL. Divergência **não é corrigida**: é devolvida
(`consistent: false`, `difference`), logada em `warn` e contada na métrica
`reconciliation_divergences_total`.

---

## 12. Consumo por SQS

> Atende: enunciado §10

**Decisão:** o `WagerTransactionsConsumer` lê `wager-transactions.fifo` e chama **o mesmo caso
de uso do HTTP**. Separado em `handle` (processa e **decide**) e `applyDecision` (executa).

| Situação | Decisão |
|---|---|
| Qualquer resultado do caso de uso (PROCESSED, REJECTED, PENDING_REFERENCE, replay) | **ack** (apaga a mensagem) |
| Erro de negócio terminal (wallet inexistente/não confere, conflito de idempotência) | **ack** + log `warn` |
| Payload inválido (JSON quebrado, tipo desconhecido, campo faltando) | **permanente:** envia para a DLQ e apaga |
| Erro transitório ou desconhecido | **retry:** não apaga; visibilidade crescente (2 s, 4 s, 8 s..., teto 300 s). Depois de 5 recebimentos, o redrive do SQS move para a DLQ |

**Ack só depois do commit:** quando a operação grava algo, `handle` só devolve "ack" depois
que o caso de uso retornou (commit feito); quem apaga é o `applyDecision`, depois. Erros de
negócio terminais também recebem ack, sem nada gravado.

**Inbox:** `inbox_messages`, com PK `(consumer_name, message_id)` sobre o `messageId` do
envelope, é gravada **na mesma transação** da operação. Se o processo morrer entre o commit
e o ack, a mensagem volta, é reconhecida como duplicada e só é apagada. São duas camadas: a
inbox deduplica a **mensagem**; a `Idempotency-Key` deduplica a **operação** (a mesma aposta
pode chegar por HTTP e pela fila, com `messageId`s diferentes).

**SIGTERM:** com `enableShutdownHooks`, o consumer para de receber, termina a mensagem em
andamento e devolve as do lote que ainda não começaram (visibilidade 0), para outra instância
pegar na hora.

**Loops de fundo sem dependências:** se Postgres ou SQS caem, os loops (consumer, publisher,
worker) não derrubam a aplicação. Quando a **rodada inteira** falha, esperam 1 s, 2 s, 4 s...
até 30 s, logam de forma amostrada (com `errorCode`, ex.: `ECONNREFUSED`) e registram
`recovered` ao voltar. Falhas de uma mensagem ou de um envio isolado seguem o retry próprio
(acima e na seção 13).

---

## 13. Transactional outbox e eventos

> Atende: enunciado §11 e restrição 4 (nunca publicar antes do commit)

**Decisão:** os eventos são gravados em `outbox_messages` **dentro do mesmo
`em.transactional`** da operação financeira. Não existe evento sem commit, nem operação que
gera evento commitada sem ele; um rollback leva os eventos junto. (A abertura de wallet com
saldo zero não gera evento.)

| Evento | Quando |
|---|---|
| `WagerTransactionProcessed` | toda transação aplicada, inclusive LOSS e OPENING |
| `WalletBalanceChanged` | **somente** quando o saldo muda (não em LOSS) |
| `WagerTransactionRejected` | recusa por regra de negócio (inclusive `REFERENCE_NOT_FOUND`) |
| `WagerTransactionPendingReference` | referência ausente |

Replays não gravam eventos. O envelope segue o enunciado: `IntegrationEvent` abstrata com
`eventType` e `version` na subclasse, `aggregateId` (`transactionId` nos eventos de
transação, `walletId` no de saldo), `correlationId`, `causationId` e dinheiro sempre como
string.

**Publisher:** em cada instância (por padrão, 500 ms depois de cada rodada, configurável), pega até 10 eventos pendentes com
`FOR UPDATE SKIP LOCKED` (`LockMode.PESSIMISTIC_PARTIAL_WRITE`), publica em
`wagering-events.fifo` e marca como publicado, na mesma transação. Falha de envio agenda nova
tentativa (1 s, 2 s, 4 s... até 5 min).
- **Vários publishers:** cada um pula as linhas travadas pelos outros; nenhum evento é
  enviado em paralelo por dois publishers.
- **Crash depois de enviar e antes do commit:** o "publicado" é desfeito, outra instância
  reenvia. A duplicata é aceita de propósito (*at-least-once*): o consumidor externo deve
  deduplicar pelo `eventId`, e `MessageDeduplicationId = eventId` faz o FIFO descartar
  reenvios em até 5 min (otimização, não garantia).
- **Fila de saída:** o enunciado só define as filas de entrada; os eventos vão para
  `wagering-events.fifo`, com `MessageGroupId = aggregateId`.

**Trade-offs:** a transação fica aberta durante o envio ao SQS (lote pequeno, timeout de 5 s
por envio). A ordem por `aggregateId` é melhor esforço: se um evento falha e o seguinte do
mesmo grupo é enviado, saem fora de ordem. O `WalletBalanceChanged` carrega `walletVersion`
e `balanceAfter`, o que permite ao consumidor detectar a ordem dos eventos de saldo.

---

## 14. Observabilidade

> Atende: enunciado §12

- **Logs** em JSON (um `LoggerService` do Nest), uma linha por evento, com `correlationId`,
  `messageId`, `transactionId`, `walletId` e `providerId` conforme o contexto. Sem payloads
  completos nem `playerId`, e sem valores de transações (a única exceção é a diferença
  registrada quando a reconciliação encontra divergência). No `POST /wagering/transactions`,
  o header `X-Correlation-Id` é propagado (ou gerado) e devolvido na resposta.
- **Métricas** em `GET /metrics`, formato Prometheus, sem biblioteca extra:
  `wager_transactions_total{status,kind,source}` (transações novas e as resolvidas pelo
  worker; replays não contam),
  `duplicates_detected_total{layer}`, `consumer_messages_total{decision}`,
  `consumer_retries_total`, `sqs_dlq_messages`, `wallet_lock_wait_seconds` e
  `lock_errors_total` (com lock pessimista, "conflito de lock" é espera ou deadlock/timeout),
  `outbox_pending` e `outbox_lag_seconds`, `outbox_publish_failures_total`,
  `wager_processing_duration_seconds` e `reconciliation_divergences_total`. Labels só com
  valores de enum, nunca ids.
- **Health:** `/health/live` (processo) e `/health/ready` (Postgres com `select 1`; SQS
  consultando a fila de entrada, com timeout de 2 s).

**Trade-off:** as métricas ficam em memória, por instância, e zeram no restart; um Prometheus
agregaria as instâncias. Lag da outbox e tamanho da DLQ são medidos na hora da coleta.

---

## 15. Testes

> Atende: enunciado §13

| Suíte | O que cobre | Quantidade |
|---|---|---|
| `test:unit` | `Money`, `Wallet`, ledger, transições, hash, eventos, outbox/inbox, mappers, métricas, backoff | 83 |
| `test:int` | Postgres e LocalStack reais: regras, idempotência, concorrência, outbox, publisher, consumer, inbox, DLQ, worker, consultas, métricas | 114 |
| `test:e2e` | 3 processos reais da aplicação, kill forçado e restart | 1 |

Nenhum teste substitui Postgres ou SQS por mock; a única simulação é a falha de uma consulta
no teste do readiness. Os testes usam um banco (`wagering_test`) e filas (`test-*`) próprios,
selecionados por um preload do `bun test`. Os testes de operações financeiras terminam
conferindo a invariante **saldo da wallet == saldo reconstruído pelo ledger** (as exceções são
testes que alteram o saldo de propósito, como o de divergência da reconciliação).

### Os 8 cenários de concorrência

| # | Cenário (§13) | Onde |
|---|---|---|
| 1 | Mesma aposta 50x em paralelo → um débito | `process-bet.test.ts` |
| 2 | Disputa de saldo (100, duas apostas de 80) | `process-bet.test.ts` (2×80, 10×80 e o teste determinístico do lock) |
| 3 | Wallets distintas em paralelo | `process-bet.test.ts` |
| 4 | ≥ 3 processos simultâneos | `test/e2e/multi-instance.test.ts` |
| 5 | Worker morto depois do commit e antes do ack | `sqs-consumer.test.ts` (simula: commit sem ack e redelivery); o kill real está no e2e |
| 6 | Dois publishers na mesma outbox | `outbox-publisher.test.ts` |
| 7 | REFUND/ROLLBACK antes da referência | `pending-reference-worker.test.ts` |
| 8 | Reinício com consistência final | `test/e2e/multi-instance.test.ts` |

**O teste end-to-end:** 3 processos da aplicação consomem 150 mensagens (mais 20 duplicadas) e
recebem 30 apostas por HTTP, todas na mesma wallet de saldo 100,00. Um processo é morto com
SIGKILL no meio do processamento e reiniciado. Resultado verificado: exatamente 100
`PROCESSED` e 80 `REJECTED`, saldo final 0,00 igual ao ledger, 100 débitos, uma linha de
inbox por mensagem única, outbox toda publicada e DLQ vazia. **Neste teste, cada mensagem
única usa um `MessageGroupId` diferente (as duplicatas reutilizam o grupo da original), de
propósito:** isso tira a serialização do FIFO e força a
disputa real pela wallet, provando que a garantia vem do banco e não do broker.

---

## 16. Trade-offs e limitações

> Atende: enunciado §14

- **Autenticação não implementada** (seção 2).
- **Hot wallet:** o lock pessimista faz fila nas operações de uma mesma wallet.
- **Publisher com transação aberta durante o envio ao SQS** e **ordem de eventos por agregado
  em melhor esforço** (seção 13).
- **Métricas em memória, por instância** (seção 14).
- **Wallet inexistente ou que não confere não gera transação gravada** (seção 7).
- **Depois de desfazer um estorno** (ROLLBACK do REFUND), a aposta original não pode ser
  estornada de novo, porque já tem um estorno aplicado. Caso raro; fica `REJECTED` e auditável.
- **Violação do índice "um estorno por operação"** só ocorre se o lock falhar (estornos
  válidos são sempre da mesma wallet); nesse caso a resposta seria um 409 de conflito.
- **Enums como `CHECK` no banco:** um código de falha novo exige migration.
- **Erros desconhecidos no consumer** são tratados como transitórios; se persistirem, a
  mensagem chega à DLQ pelo redrive.
- **Multi-moeda:** o modelo suporta, mas só BRL foi exercitado.
- **`FAILED` e `INTERNAL_ERROR`** existem no domínio, mas nenhum fluxo os produz hoje (seção 5).
- **`PENDING_REFERENCE` esgotado não reabre:** uma referência que chegue depois do limite não
  muda a transação já `REJECTED`.
- **Limites de entrada:** valores e textos não são limitados à capacidade das colunas
  (`bigint`, `varchar(255)`); entradas extremas podem gerar erro de persistência em vez de
  `INVALID_PAYLOAD`.
- **Visibilidade do SQS não é renovada:** o consumer processa até 10 mensagens em sequência
  com visibilidade de 30 s; um processamento muito lento permite redelivery antes do fim
  (absorvido pela inbox e pela idempotência).
- **Outbox sem limite de tentativas:** um evento com falha permanente segue sendo reagendado
  (no máximo a cada 5 min). Não há rotina de limpeza da outbox publicada nem da inbox.
- **A fila de eventos (`wagering-events.fifo`) não tem DLQ nem consumidor neste projeto:** os
  consumidores são externos e responsáveis por deduplicar pelo `eventId`.
- **Observabilidade depende das dependências:** sem Postgres, o `/metrics` não responde por
  completo; o readiness confere só a fila de entrada.
- **WIN não valida a referência:** o `referenceExternalTransactionId` opcional do WIN é gravado,
  mas não é conferido (existência, tipo, status ou correspondência com a aposta). O enunciado
  só diz que o WIN "pode referenciar" a BET.
- **Sem teste de carga** (diferencial opcional, fora do escopo).
