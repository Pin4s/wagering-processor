# Wagering Processor

Serviço financeiro de processamento de apostas (desafio técnico Jungle Gaming).
NestJS + Bun + TypeScript + PostgreSQL + MikroORM + SQS (LocalStack).

## Requisitos

- [Bun](https://bun.sh) 1.x (desenvolvido com 1.4.4)
- Docker e Docker Compose
- Um token do LocalStack (`LOCALSTACK_AUTH_TOKEN`)

## Como rodar

```bash
# 1. Variáveis de ambiente
cp .env.example .env
# Edite o .env e preencha LOCALSTACK_AUTH_TOKEN. Os demais valores já funcionam localmente.

# 2. Infraestrutura (Postgres + LocalStack). As filas SQS são criadas automaticamente.
docker compose up -d

# 3. Dependências
bun install

# 4. Banco: aplica todas as migrations
bun run migrate:up

# 5. Aplicação (porta 3000)
bun run start
```

Conferir se está tudo de pé:

```bash
curl localhost:3000/health/ready
# {"status":"ok","checks":{"postgres":"ok","sqs":"ok"}}
```

## Testes

Todos usam Postgres e LocalStack reais (a infraestrutura precisa estar de pé).

```bash
bun run test:unit   # regras de domínio (sem banco)
bun run test:int    # integração: banco, SQS, concorrência, idempotência
bun run test:e2e    # 3 processos reais da aplicação, com kill e restart (~35 s)
```

## Comandos úteis

| Comando | O que faz |
|---|---|
| `bun run migrate:up` | aplica as migrations pendentes |
| `bun run migrate:down` | desfaz a última migration |
| `bun run migrate:create` | gera uma migration a partir das entidades |