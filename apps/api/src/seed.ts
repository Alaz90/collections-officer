import { DEFAULT_PLAYBOOK, type Borrower, type Loan, type Payment, type Plan } from '@co/shared';
import { addDays } from './domain/dates.js';
import type { Lender, Store } from './ports.js';

/**
 * Demo portfolio, dated relative to today so the story always works:
 * Abebe (prevent), Sara (recover), Dawit (hand over), and a mixed book
 * around them. All names and numbers are invented.
 */

type Spec = {
  name: string;
  region: string;
  sector: Borrower['sector'];
  instalmentBirr: number;
  /** Days from today of the first due date; negative = in the past. */
  firstDue: number;
  instalments: number;
  /** For each past instalment: days late it was paid, or null if unpaid, or a share (0..1) if partly paid. */
  history: Array<number | null | { partial: number; late: number }>;
  rescheduleCount?: number;
  brokenPlans?: number;
};

const SPECS: Spec[] = [
  // The three stories
  { name: 'Abebe Kebede', region: 'Sidama', sector: 'farming', instalmentBirr: 2000, firstDue: -50, instalments: 4, history: [0, 8] },
  { name: 'Sara Tesfaye', region: 'Addis Ababa', sector: 'trade', instalmentBirr: 3000, firstDue: -35, instalments: 4, history: [0, null] },
  { name: 'Dawit Alemu', region: 'Oromia', sector: 'trade', instalmentBirr: 2500, firstDue: -80, instalments: 5, history: [5, { partial: 0.3, late: 20 }, null], rescheduleCount: 2, brokenPlans: 2 },
  // The rest of the book
  { name: 'Hirut Bekele', region: 'Sidama', sector: 'farming', instalmentBirr: 1500, firstDue: -40, instalments: 4, history: [0, 3] },
  { name: 'Mulugeta Haile', region: 'South Ethiopia', sector: 'farming', instalmentBirr: 1800, firstDue: -45, instalments: 4, history: [4, { partial: 0.5, late: 0 }] },
  { name: 'Tigist Worku', region: 'Addis Ababa', sector: 'salaried', instalmentBirr: 2200, firstDue: -55, instalments: 6, history: [0, 0] },
  { name: 'Yonas Girma', region: 'Amhara', sector: 'trade', instalmentBirr: 1200, firstDue: -20, instalments: 4, history: [null] },
  { name: 'Meron Assefa', region: 'Oromia', sector: 'farming', instalmentBirr: 1600, firstDue: -30, instalments: 4, history: [1] },
  { name: 'Biruk Tadesse', region: 'Addis Ababa', sector: 'trade', instalmentBirr: 4000, firstDue: -10, instalments: 3, history: [null] },
  { name: 'Selam Abera', region: 'Sidama', sector: 'farming', instalmentBirr: 1400, firstDue: -60, instalments: 5, history: [0, 6, { partial: 0.4, late: 0 }] },
  { name: 'Kebede Mengistu', region: 'Amhara', sector: 'farming', instalmentBirr: 2600, firstDue: -25, instalments: 4, history: [0] },
  { name: 'Liya Solomon', region: 'Addis Ababa', sector: 'salaried', instalmentBirr: 1800, firstDue: 3, instalments: 4, history: [] },
  { name: 'Fikru Negash', region: 'Oromia', sector: 'trade', instalmentBirr: 3500, firstDue: -65, instalments: 4, history: [12, 15, null] },
  { name: 'Aster Demissie', region: 'South Ethiopia', sector: 'farming', instalmentBirr: 1300, firstDue: -15, instalments: 4, history: [0] },
  { name: 'Samuel Wolde', region: 'Addis Ababa', sector: 'trade', instalmentBirr: 2800, firstDue: -4, instalments: 4, history: [null] },
  { name: 'Eden Mekonnen', region: 'Sidama', sector: 'trade', instalmentBirr: 1700, firstDue: 6, instalments: 4, history: [] },
];

export const DEMO_LENDER = (id: string): Lender => ({
  id,
  name: 'Demo Lender',
  playbook: { ...DEFAULT_PLAYBOOK, autonomy: 'approve_sensitive' },
  segments: [],
  receivingAccounts: ['1000123456789', '0911000000'],
  timezoneOffsetHours: 3,
});

export async function seedDemo(store: Store, lenderId: string, today: string) {
  await store.lenders.put(DEMO_LENDER(lenderId));
  let k = 0;
  for (const s of SPECS) {
    k++;
    const borrowerId = `${lenderId}-b${k}`;
    const loanId = `${lenderId}-L${k}`;
    const amount = s.instalmentBirr * 100;
    const schedule = Array.from({ length: s.instalments }, (_, i) => ({
      dueDate: addDays(today, s.firstDue + 30 * i),
      amountCents: amount,
      paidCents: 0,
    }));
    const payments: Payment[] = [];
    s.history.forEach((h, i) => {
      const inst = schedule[i];
      if (!inst || h === null) return;
      const share = typeof h === 'number' ? 1 : h.partial;
      const late = typeof h === 'number' ? h : h.late;
      const cents = Math.round(amount * share);
      inst.paidCents = cents;
      payments.push({
        id: `${loanId}-p${i}`,
        lenderId,
        loanId,
        amountCents: cents,
        source: 'link',
        reference: `${loanId}_seed${i}`,
        status: 'verified',
        receivedAt: `${addDays(inst.dueDate, late)}T09:00:00.000Z`,
      });
    });
    const borrower: Borrower = {
      id: borrowerId,
      lenderId,
      name: s.name,
      phone: `+2519${String(10000000 + k * 1234567).slice(0, 8)}`,
      preferredChannel: 'telegram',
      language: 'en',
      region: s.region,
      sector: s.sector,
      incomePattern: s.sector === 'farming' ? 'harvest' : s.sector === 'salaried' ? 'monthly' : 'market_days',
      optedOut: false,
      caseSummary: '',
    };
    const loan: Loan = {
      id: loanId,
      lenderId,
      borrowerId,
      principalCents: amount * s.instalments,
      schedule,
      status: 'current',
      rescheduleCount: s.rescheduleCount ?? 0,
      hold: null,
      createdAt: addDays(today, s.firstDue - 30),
    };
    await store.borrowers.put(borrower);
    await store.loans.put(loan);
    for (const p of payments) await store.payments.put(p);
    for (let b = 0; b < (s.brokenPlans ?? 0); b++) {
      const plan: Plan = {
        id: `${loanId}-oldplan${b}`,
        lenderId,
        loanId,
        kind: 'payment_plan',
        instalments: [{ dueDate: addDays(today, -40 + b * 15), amountCents: amount }],
        status: 'broken',
        realism: { ok: true, score: 0.7, reasons: ['fits this borrower’s payment history'] },
        createdAt: `${addDays(today, -50 + b * 15)}T09:00:00.000Z`,
      };
      await store.plans.put(plan);
    }
  }
}

/** Demo rainfall: the two southern regions in a dry spell. Shown as "demo data" in the UI. */
export const DEMO_RAINFALL: Record<string, number> = { Sidama: 0.4, 'South Ethiopia': 0.55, Oromia: 0.95, Amhara: 1.05, 'Addis Ababa': 1 };
