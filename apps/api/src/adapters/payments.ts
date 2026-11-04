import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Borrower } from '@co/shared';
import type { PaymentLink, PaymentProvider } from '../ports.js';

const CHAPA = 'https://api.chapa.co/v1';

/** Chapa, an Ethiopian payment gateway. Test mode uses a CHASECK_TEST key. */
export class ChapaPayments implements PaymentProvider {
  readonly name = 'chapa';

  constructor(
    private secretKey: string,
    private publicBaseUrl: string,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  async createLink(input: { amountCents: number; reference: string; borrower: Borrower; description: string }): Promise<PaymentLink> {
    const [first, ...rest] = input.borrower.name.split(' ');
    const res = await this.fetchImpl(`${CHAPA}/transaction/initialize`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.secretKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount: (input.amountCents / 100).toFixed(2),
        currency: 'ETB',
        email: input.borrower.email,
        first_name: first,
        last_name: rest.join(' ') || first,
        phone_number: input.borrower.phone,
        tx_ref: input.reference,
        callback_url: `${this.publicBaseUrl}/webhooks/chapa`,
        return_url: `${this.publicBaseUrl}/paid`,
        customization: { title: 'Loan payment', description: input.description.slice(0, 50) },
      }),
    });
    const body = (await res.json()) as { status?: string; message?: unknown; data?: { checkout_url?: string } };
    if (!res.ok || body.status !== 'success' || !body.data?.checkout_url) {
      throw new Error(`Chapa initialize failed: ${JSON.stringify(body.message ?? body)}`);
    }
    return { url: body.data.checkout_url, reference: input.reference };
  }

  async verify(reference: string) {
    const res = await this.fetchImpl(`${CHAPA}/transaction/verify/${encodeURIComponent(reference)}`, {
      headers: { Authorization: `Bearer ${this.secretKey}` },
    });
    const body = (await res.json()) as { data?: { status?: string; amount?: string | number } };
    const paid = res.ok && body.data?.status === 'success';
    return { paid, amountCents: paid ? Math.round(Number(body.data?.amount ?? 0) * 100) : 0 };
  }
}

/** Optional webhook signature check (HMAC-SHA256 of the raw body). */
export function validChapaSignature(rawBody: string, signature: string | undefined, secret: string | undefined) {
  if (!secret) return true; // verification against the API is the real check
  if (!signature) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Local payment page for development and the simulator: the link opens a
 * page on this server where "Pay" marks the reference as paid.
 */
export class FakePayments implements PaymentProvider {
  readonly name = 'fake';
  private paid = new Map<string, number>();
  private amounts = new Map<string, number>();

  constructor(private publicBaseUrl: string) {}

  async createLink(input: { amountCents: number; reference: string }): Promise<PaymentLink> {
    this.amounts.set(input.reference, input.amountCents);
    return { url: `${this.publicBaseUrl}/pay/${input.reference}`, reference: input.reference };
  }

  /** Called by the fake checkout page. */
  markPaid(reference: string) {
    const amount = this.amounts.get(reference);
    if (amount === undefined) return false;
    this.paid.set(reference, amount);
    return true;
  }

  amountFor(reference: string) {
    return this.amounts.get(reference);
  }

  async verify(reference: string) {
    const amount = this.paid.get(reference);
    return { paid: amount !== undefined, amountCents: amount ?? 0 };
  }
}
