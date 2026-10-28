export interface MoneyProps {
  amount: string;
  currency: string;
}

export class InvalidMoneyError extends Error { }

export class CurrencyMismatchError extends Error { }

const AMOUNT_RE = /^\d+(\.\d{1,2})?$/;
const CURRENCY_RE = /^[A-Z]{3}$/;


function parseCents(amount: string): bigint {
  const [integer, fraction = ''] = amount.split('.');
  return BigInt(integer + fraction.padEnd(2, '0'));
}

function formatCents(cents: bigint): string {
  const digits = cents.toString().padStart(3, '0');
  return `${digits.slice(0, -2)}.${digits.slice(-2)}`;
}


export class Money {
  private constructor(
    private readonly cents: bigint,
    public readonly currency: string,
  ) { }

  static from(props: MoneyProps): Money {
    if (typeof props.amount !== 'string' || !AMOUNT_RE.test(props.amount)) {
      throw new InvalidMoneyError('invalid amount format');
    }

    if (typeof props.currency !== 'string' || !CURRENCY_RE.test(props.currency)) {
      throw new InvalidMoneyError('invalid currency format');
    }

    return new Money(parseCents(props.amount), props.currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.cents + other.cents, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.cents - other.cents, this.currency);
  }

  toJSON(): MoneyProps {
    return {
      amount: formatCents(this.cents),
      currency: this.currency
    };
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(`${this.currency} vs ${other.currency}`);
    }
  }
}