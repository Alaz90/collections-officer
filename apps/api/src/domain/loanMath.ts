import type { Instalment, Loan, Payment } from '@co/shared';
import { daysBetween } from './dates.js';

/** Amount still owed on one instalment. */
export function remaining(i: Instalment): number {
  return Math.max(0, i.amountCents - i.paidCents);
}

export function outstandingCents(loan: Loan): number {
  return loan.schedule.reduce((sum, i) => sum + remaining(i), 0);
}

/** Instalments due on or before `today` that are not fully paid. */
export function overdueInstalments(loan: Loan, today: string): Instalment[] {
  return loan.schedule.filter((i) => i.dueDate < today && remaining(i) > 0);
}

export function overdueCents(loan: Loan, today: string): number {
  return overdueInstalments(loan, today).reduce((sum, i) => sum + remaining(i), 0);
}

/** Days since the oldest unpaid due date, or 0 when nothing is overdue. */
export function daysPastDue(loan: Loan, today: string): number {
  const oldest = overdueInstalments(loan, today)[0];
  return oldest ? daysBetween(oldest.dueDate, today) : 0;
}

/** The next instalment that still needs paying, overdue or not. */
export function nextUnpaid(loan: Loan): Instalment | undefined {
  return loan.schedule.find((i) => remaining(i) > 0);
}

/**
 * Applies a payment to the oldest unpaid instalments first and returns the
 * updated schedule. Pure: the input loan is not changed.
 */
export function applyPayment(loan: Loan, amountCents: number): Loan {
  let left = amountCents;
  const schedule = loan.schedule.map((i) => {
    if (left <= 0) return i;
    const take = Math.min(left, remaining(i));
    left -= take;
    return { ...i, paidCents: i.paidCents + take };
  });
  const closed = schedule.every((i) => remaining(i) === 0);
  return { ...loan, schedule, status: closed ? 'closed' : loan.status };
}

export interface RepaymentHistory {
  /** Past instalments that are fully paid. */
  paidCount: number;
  /** Of those, how many were completed after their due date. */
  paidLateCount: number;
  /** Average days late across instalments paid late. */
  avgDaysLate: number;
  /** Whether the most recent past-due instalment was only partly paid. */
  lastWasPartial: boolean;
  /** Median payment size in cents, or 0 with no payments. */
  typicalPaymentCents: number;
}

/**
 * Replays verified payments against the schedule to learn how this borrower
 * has paid so far. Used by the risk score and the realism check.
 */
export function repaymentHistory(loan: Loan, payments: Payment[], today: string): RepaymentHistory {
  const verified = payments
    .filter((p) => p.loanId === loan.id && p.status !== 'rejected')
    .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));

  const due = loan.schedule.map((i) => ({ dueDate: i.dueDate, amount: i.amountCents, paid: 0, completedOn: '' }));
  for (const p of verified) {
    let left = p.amountCents;
    const day = p.receivedAt.slice(0, 10);
    for (const d of due) {
      if (left <= 0) break;
      const take = Math.min(left, d.amount - d.paid);
      if (take <= 0) continue;
      d.paid += take;
      left -= take;
      if (d.paid >= d.amount && !d.completedOn) d.completedOn = day;
    }
  }

  const past = due.filter((d) => d.dueDate < today);
  const completed = past.filter((d) => d.completedOn);
  const late = completed.filter((d) => d.completedOn > d.dueDate);
  const avgDaysLate = late.length
    ? late.reduce((s, d) => s + daysBetween(d.dueDate, d.completedOn), 0) / late.length
    : 0;
  const lastPast = past[past.length - 1];
  const lastWasPartial = !!lastPast && lastPast.paid > 0 && lastPast.paid < lastPast.amount;

  const sizes = verified.map((p) => p.amountCents).sort((a, b) => a - b);
  const typicalPaymentCents = sizes.length ? sizes[Math.floor((sizes.length - 1) / 2)]! : 0;

  return {
    paidCount: completed.length,
    paidLateCount: late.length,
    avgDaysLate,
    lastWasPartial,
    typicalPaymentCents,
  };
}
