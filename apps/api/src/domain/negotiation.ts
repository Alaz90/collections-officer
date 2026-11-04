import type { Loan, Playbook, ReplyReading } from '@co/shared';
import { addDays, daysBetween } from './dates.js';
import { latestAllowedDate, planTarget, type ProposedInstalment } from './policy.js';

/**
 * Turns what a borrower offered into a concrete plan. Deterministic: Gemini
 * reads the reply into structured data, this code builds the plan, and the
 * policy layer then checks it. When the offer is below the playbook minimum,
 * it returns a single counter-offer at the limit.
 */

export type NegotiationOutcome =
  | { kind: 'accept'; instalments: ProposedInstalment[] }
  | { kind: 'counter'; instalments: ProposedInstalment[]; reason: string }
  | { kind: 'nothing_to_plan' };

/** Splits `cents` into `n` instalments; any remainder goes on the last one. */
export function split(cents: number, dates: string[]): ProposedInstalment[] {
  const n = dates.length;
  const base = Math.floor(cents / n);
  return dates.map((dueDate, i) => ({ dueDate, amountCents: i === n - 1 ? cents - base * (n - 1) : base }));
}

/** Evenly spaced dates from `from` (exclusive) up to `until` (inclusive). */
export function spreadDates(from: string, until: string, count: number): string[] {
  const span = Math.max(count, daysBetween(from, until));
  const step = Math.floor(span / count);
  return Array.from({ length: count }, (_, i) => (i === count - 1 ? until : addDays(from, step * (i + 1))));
}

export function buildPlan(input: {
  loan: Loan;
  playbook: Playbook;
  reading: Pick<ReplyReading, 'offerNowCents' | 'proposedInstalments'>;
  today: string;
}): NegotiationOutcome {
  const { loan, playbook, reading, today } = input;
  const target = planTarget(loan, today).cents;
  if (target <= 0) return { kind: 'nothing_to_plan' };

  const minFirst = Math.ceil(target * playbook.minFirstPaymentShare);
  const latest = latestAllowedDate(loan, playbook, today);
  const offerNow = Math.min(reading.offerNowCents ?? 0, target);

  // The borrower's own dates are used when they fit; otherwise spread evenly.
  const restCount = Math.max(1, Math.min(playbook.maxInstalments - 1, reading.proposedInstalments.length || 2));
  const theirDates = reading.proposedInstalments
    .map((p) => p.dueDate)
    .filter((d) => d > today && d <= latest)
    .sort()
    .slice(0, restCount);
  const restDates = theirDates.length === restCount ? theirDates : spreadDates(today, latest, restCount);

  const plan = (first: number): ProposedInstalment[] => {
    const rest = target - first;
    const head = [{ dueDate: today, amountCents: first }];
    return rest > 0 ? [...head, ...split(rest, restDates)] : head;
  };

  if (offerNow >= minFirst) return { kind: 'accept', instalments: plan(offerNow) };
  return {
    kind: 'counter',
    instalments: plan(minFirst),
    reason:
      offerNow > 0
        ? `offer of ${offerNow} is below the ${Math.round(playbook.minFirstPaymentShare * 100)}% minimum`
        : 'no amount offered now',
  };
}

/**
 * Early schedule change for a borrower who is not late yet: move part of the
 * next instalment to a date that fits their income, within the extension limit.
 */
export function earlyScheduleChange(input: {
  loan: Loan;
  playbook: Playbook;
  incomeDate: string | null;
  today: string;
}): ProposedInstalment[] {
  const { loan, playbook, today } = input;
  const target = planTarget(loan, today);
  const latest = latestAllowedDate(loan, playbook, today);
  const firstDate = target.dueDate > today ? target.dueDate : today;
  const later = input.incomeDate && input.incomeDate > firstDate && input.incomeDate <= latest ? input.incomeDate : latest;
  const first = Math.ceil(target.cents * Math.max(playbook.minFirstPaymentShare, 0.5));
  return [
    { dueDate: firstDate, amountCents: first },
    { dueDate: later, amountCents: target.cents - first },
  ];
}
