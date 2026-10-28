export interface MoneyProps {
  amount: string;
  currency: string;
}

function parseCents(amount: string): bigint {
  const [integer, fraction = ''] = amount.split('.');
  return BigInt(integer + fraction.padEnd(2, '0'));
}

function formatCents(cents: bigint): string {
  const digits = cents.toString().padStart(3, '0');
  return `${digits.slice(0, -2)}.${digits.slice(-2)}`;
}

export class InvalidMoneyError extends Error { }

const AMOUNT_RE = /^\d+(\.\d{1,2})?$/;

export class Money {
  private constructor(
    private readonly cents: bigint,
    public readonly currency: string,
  ) { }

  static from(props: MoneyProps): Money {
    if (typeof props.amount !== 'string' || !AMOUNT_RE.test(props.amount)) {
      throw new InvalidMoneyError('invalid amount format');
    }

    return new Money(parseCents(props.amount), props.currency);
  }

  toJSON(): MoneyProps {
    return {
      amount: formatCents(this.cents),
      currency: this.currency
    };
  }
}