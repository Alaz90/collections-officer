import { DEFAULT_PLAYBOOK, type Borrower, type Loan, type Payment, type Playbook } from '@co/shared';

export const TODAY = '2026-11-10';

export function borrower(over: Partial<Borrower> = {}): Borrower {
  return {
    id: 'b1',
    lenderId: 'l1',
    name: 'Abebe Kebede',
    telegramChatId: '1001',
    preferredChannel: 'telegram',
    language: 'en',
    region: 'Sidama',
    sector: 'farming',
    incomePattern: 'harvest',
    optedOut: false,
    caseSummary: '',
    ...over,
  };
}

/** A loan of 3 monthly instalments of 2,000.00 (200,000 cents each). */
export function loan(over: Partial<Loan> = {}): Loan {
  return {
    id: 'loan1',
    lenderId: 'l1',
    borrowerId: 'b1',
    principalCents: 600_000,
    schedule: [
      { dueDate: '2026-09-20', amountCents: 200_000, paidCents: 200_000 },
      { dueDate: '2026-10-20', amountCents: 200_000, paidCents: 0 },
      { dueDate: '2026-11-20', amountCents: 200_000, paidCents: 0 },
    ],
    status: 'current',
    rescheduleCount: 0,
    createdAt: '2026-08-20',
    ...over,
  };
}

export function payment(over: Partial<Payment> = {}): Payment {
  return {
    id: 'p1',
    lenderId: 'l1',
    loanId: 'loan1',
    amountCents: 200_000,
    source: 'link',
    reference: 'tx-1',
    status: 'verified',
    receivedAt: '2026-09-19T10:00:00Z',
    ...over,
  };
}

export function playbook(over: Partial<Playbook> = {}): Playbook {
  return { ...DEFAULT_PLAYBOOK, ...over };
}
