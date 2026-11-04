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

/** Longest plan the agent will put to a manager; beyond this a person restructures. */
export const MAX_AFFORDABLE_INSTALMENTS = 6;

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

  /**
   * Later instalments follow what the borrower said they can pay. If the
   * rest fits the playbook at a size close to that, the plan stays inside it;
   * otherwise the plan is spread wider at an affordable size, which the
   * policy layer sends to a manager. An evenly split plan the borrower
   * cannot afford would only break.
   */
  // Dates the borrower proposed are honoured up to 60 days out; the policy
  // layer sends anything beyond the playbook's extension to a manager.
  const horizon = addDays(today, 60);
  const theirOwn = [...new Set(reading.proposedInstalments.map((p) => p.dueDate))]
    .filter((d) => d > today && d <= horizon)
    .sort()
    .slice(0, MAX_AFFORDABLE_INSTALMENTS);

  const plan = (first: number): ProposedInstalment[] => {
    const rest = target - first;
    const head = [{ dueDate: today, amountCents: first }];
    if (rest <= 0) return head;
    if (theirOwn.length) return [...head, ...split(rest, theirOwn)];
    const affordable = Math.max(first, 1);
    const fitCount = Math.max(1, playbook.maxInstalments - 1);
    const fitsPlaybook = Math.ceil(rest / fitCount) <= affordable * 1.25;
    if (fitsPlaybook) {
      return [...head, ...split(rest, spreadDates(today, latest, fitCount))];
    }
    const count = Math.min(MAX_AFFORDABLE_INSTALMENTS, Math.ceil(rest / affordable));
    const dates = Array.from({ length: count }, (_, i) => addDays(today, 14 * (i + 1)));
    return [...head, ...split(rest, dates)];
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
  // Align with the borrower's income when it is known (a manager approves it if beyond the limit).
  const later = input.incomeDate && input.incomeDate > firstDate && input.incomeDate <= addDays(today, 60) ? input.incomeDate : latest;
  const first = Math.ceil(target.cents * Math.max(playbook.minFirstPaymentShare, 0.5));
  return [
    { dueDate: firstDate, amountCents: first },
    { dueDate: later, amountCents: target.cents - first },
  ];
}
