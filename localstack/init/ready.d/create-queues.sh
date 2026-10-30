#!/bin/sh
set -eu

create_transaction_queues() {
  transactions_queue=$1
  transactions_dlq=$2

  dlq_url=$(awslocal sqs create-queue \
    --region "$AWS_REGION" \
    --queue-name "$transactions_dlq" \
    --attributes FifoQueue=true \
    --query QueueUrl --output text)
  printf 'Fila pronta: %s\n' "$transactions_dlq"

  dlq_arn=$(awslocal sqs get-queue-attributes \
    --region "$AWS_REGION" \
    --queue-url "$dlq_url" \
    --attribute-names QueueArn \
    --query Attributes.QueueArn --output text)

  attributes=$(cat <<EOF
{
  "FifoQueue": "true",
  "VisibilityTimeout": "30",
  "RedrivePolicy": "{\"deadLetterTargetArn\":\"${dlq_arn}\",\"maxReceiveCount\":5}"
}
EOF
)

  awslocal sqs create-queue \
    --region "$AWS_REGION" \
    --queue-name "$transactions_queue" \
    --attributes "$attributes" \
    --query QueueUrl --output text
  printf 'Fila pronta: %s\n' "$transactions_queue"
}

create_transaction_queues "$SQS_WAGER_TRANSACTIONS_QUEUE" "$SQS_WAGER_TRANSACTIONS_DLQ"
create_transaction_queues test-wager-transactions.fifo test-wager-transactions-dlq.fifo

for events_queue in "$SQS_EVENTS_QUEUE" test-wagering-events.fifo; do
  awslocal sqs create-queue \
    --region "$AWS_REGION" \
    --queue-name "$events_queue" \
    --attributes FifoQueue=true \
    --query QueueUrl --output text
  printf 'Fila pronta: %s\n' "$events_queue"
done
