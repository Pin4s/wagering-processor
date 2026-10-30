import { Injectable } from '@nestjs/common';
import { WagerTransactionKind, WagerTransactionStatus } from '../../modules/wagering/domain/wager-transaction';

type CounterName =
  | 'wager_transactions_total'
  | 'duplicates_detected_total'
  | 'lock_errors_total'
  | 'consumer_messages_total'
  | 'consumer_retries_total'
  | 'outbox_publish_failures_total'
  | 'reconciliation_divergences_total';
type HistogramName = 'wager_processing_duration_seconds' | 'wallet_lock_wait_seconds';

interface CounterDefinition {
  help: string;
  labels: Readonly<Record<string, readonly string[]>>;
}

const COUNTERS = new Map<CounterName, CounterDefinition>([
  ['wager_transactions_total', {
    help: 'Transacoes novas por status, tipo e origem.',
    labels: { status: Object.values(WagerTransactionStatus), kind: Object.values(WagerTransactionKind), source: ['http', 'sqs', 'worker'] },
  }],
  ['duplicates_detected_total', { help: 'Replays detectados por camada.', labels: { layer: ['idempotency', 'inbox'] } }],
  ['lock_errors_total', { help: 'Erros de lock por tipo.', labels: { type: ['deadlock', 'lock_timeout'] } }],
  ['consumer_messages_total', { help: 'Decisoes do consumer por mensagem.', labels: { decision: ['ack', 'retry', 'dlq'] } }],
  ['consumer_retries_total', { help: 'Decisoes de nova tentativa do consumer.', labels: {} }],
  ['outbox_publish_failures_total', { help: 'Falhas de envio dos eventos da outbox.', labels: {} }],
  ['reconciliation_divergences_total', { help: 'Divergencias encontradas na reconciliacao.', labels: {} }],
]);

const HISTOGRAMS = new Map<HistogramName, string>([
  ['wager_processing_duration_seconds', 'Duracao das chamadas ao caso de uso em segundos.'],
  ['wallet_lock_wait_seconds', 'Tempo para obter o lock de escrita da wallet em segundos.'],
]);
const BUCKETS = [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

export interface ScrapeGauges {
  outbox_pending?: number;
  outbox_lag_seconds?: number;
  sqs_dlq_messages?: number;
}

const GAUGES = new Map<keyof ScrapeGauges, string>([
  ['outbox_pending', 'Eventos pendentes na outbox no momento da coleta.'],
  ['outbox_lag_seconds', 'Idade do evento pendente mais antigo em segundos.'],
  ['sqs_dlq_messages', 'Numero aproximado de mensagens visiveis na DLQ.'],
]);

interface HistogramState {
  counts: number[];
  sum: number;
  count: number;
}

@Injectable()
export class MetricsRegistry {
  private readonly counters = new Map<CounterName, Map<string, number>>();
  private readonly histograms = new Map<HistogramName, HistogramState>();

  constructor() {
    for (const [name, definition] of COUNTERS) {
      const samples = new Map<string, number>();
      if (Object.keys(definition.labels).length === 0) {
        samples.set('', 0);
      }
      this.counters.set(name, samples);
    }
    for (const name of HISTOGRAMS.keys()) {
      this.histograms.set(name, { counts: BUCKETS.map(() => 0), sum: 0, count: 0 });
    }
  }

  increment(name: CounterName, labels: Readonly<Record<string, string>> = {}): void {
    const definition = COUNTERS.get(name);
    const samples = this.counters.get(name);
    if (!definition || !samples) {
      throw new Error('unknown counter');
    }
    if (Object.keys(labels).length !== Object.keys(definition.labels).length) {
      throw new Error('unexpected metric labels');
    }
    const parts: string[] = [];
    for (const [label, allowed] of Object.entries(definition.labels)) {
      const value = labels[label];
      if (value === undefined || !allowed.includes(value)) {
        throw new Error('metric labels must use the configured enum values');
      }
      parts.push(`${label}="${value}"`);
    }
    let suffix = '';
    if (parts.length > 0) {
      suffix = `{${parts.join(',')}}`;
    }
    samples.set(suffix, (samples.get(suffix) ?? 0) + 1);
  }

  observe(name: HistogramName, seconds: number): void {
    const histogram = this.histograms.get(name);
    if (!histogram || !Number.isFinite(seconds) || seconds < 0) {
      throw new Error('histogram observations must be finite non-negative seconds');
    }
    histogram.sum += seconds;
    histogram.count++;
    for (let index = 0; index < BUCKETS.length; index++) {
      if (seconds <= BUCKETS[index]!) {
        histogram.counts[index] = (histogram.counts[index] ?? 0) + 1;
      }
    }
  }

  render(gauges: ScrapeGauges = {}): string {
    const lines: string[] = [];
    for (const [name, definition] of COUNTERS) {
      lines.push(`# HELP ${name} ${definition.help}`, `# TYPE ${name} counter`);
      for (const [suffix, count] of this.counters.get(name) ?? []) {
        lines.push(`${name}${suffix} ${count}`);
      }
    }
    for (const [name, help] of HISTOGRAMS) {
      const histogram = this.histograms.get(name);
      if (!histogram) {
        continue;
      }
      lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} histogram`);
      for (let index = 0; index < BUCKETS.length; index++) {
        lines.push(`${name}_bucket{le="${BUCKETS[index]}"} ${histogram.counts[index]}`);
      }
      lines.push(`${name}_bucket{le="+Inf"} ${histogram.count}`);
      lines.push(`${name}_sum ${histogram.sum}`, `${name}_count ${histogram.count}`);
    }
    for (const [name, help] of GAUGES) {
      const value = gauges[name];
      if (value !== undefined) {
        lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, `${name} ${value}`);
      }
    }
    return lines.join('\n') + '\n';
  }
}
