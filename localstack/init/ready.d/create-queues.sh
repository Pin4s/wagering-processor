#!/bin/sh
set -eu

dlq_url=$(awslocal sqs create-queue \
  --region "$AWS_REGION" \
  --queue-name "$SQS_WAGER_TRANSACTIONS_DLQ" \
  --attributes FifoQueue=true \
  --query QueueUrl --output text)
printf 'Fila pronta: %s\n' "$SQS_WAGER_TRANSACTIONS_DLQ"

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
  --queue-name "$SQS_WAGER_TRANSACTIONS_QUEUE" \
  --attributes "$attributes" \
  --query QueueUrl --output text
printf 'Fila pronta: %s\n' "$SQS_WAGER_TRANSACTIONS_QUEUE"

awslocal sqs create-queue \
  --region "$AWS_REGION" \
  --queue-name "$SQS_EVENTS_QUEUE" \
  --attributes FifoQueue=true \
  --query QueueUrl --output text
printf 'Fila pronta: %s\n' "$SQS_EVENTS_QUEUE"
