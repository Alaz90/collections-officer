import type { Borrower, Loan, Playbook } from '@co/shared';
import { addDays, daysBetween, maxDate } from './dates.js';
import { overdueCents, overdueInstalments, nextUnpaid } from './loanMath.js';

/**
 * The policy layer. Gemini proposes; this code decides what is allowed.
 * Nothing here calls a model, so the rules hold whatever a borrower writes.
 */

export type Verdict = 'allow' | 'needs_approval' | 'deny';

export interface PolicyResult {
  verdict: Verdict;
  reasons: string[];
}

const allow = (): PolicyResult => ({ verdict: 'allow', reasons: [] });

/** Words a collections message must never contain. Checked after generation. */
const BANNED = [
  /\bpolice\b/i,
  /\barrest/i,
  /\bjail\b/i,
  /\bprison\b/i,
  /\bshame/i,
  /\bembarrass/i,
  /\byour (family|friends|neighbou?rs|employer|boss)\b/i,
  /\btell (everyone|your)/i,
  /\blegal action\b/i,
  /\bcourt\b/i,
  /\bblacklist/i,
  /\bstupid\b/i,
  /\bliar\b/i,
  /\bthief\b/i,
];

export function checkTone(text: string): PolicyResult {
  const hits = BANNED.filter((re) => re.test(text)).map((re) => `contains a banned phrase (${re.source})`);
  if (text.trim().length === 0) hits.push('message is empty');
  if (text.length > 700) hits.push('message is too long');
  return hits.length ? { verdict: 'deny', reasons: hits } : allow();
}

export interface ContactContext {
  borrower: Borrower;
  playbook: Playbook;
  /** Local hour at the borrower's location, 0..23. */
  localHour: number;
  /** Messages already sent to this borrower today. */
  sentToday: number;
}

export function checkContact(ctx: ContactContext): PolicyResult {
  const reasons: string[] = [];
  if (ctx.borrower.optedOut) reasons.push('borrower opted out of automated messages');
  const { start, end } = ctx.playbook.contactHours;
  if (ctx.localHour < start || ctx.localHour >= end) reasons.push(`outside contact hours (${start}:00–${end}:00)`);
  if (ctx.sentToday >= ctx.playbook.dailyContactCap) reasons.push('daily contact limit reached');
  return reasons.length ? { verdict: 'deny', reasons } : allow();
}

export interface ProposedInstalment {
  dueDate: string;
  amountCents: number;
}

/**
 * Checks a proposed plan for an overdue or soon-due amount against the
 * playbook. `target` is what the plan must cover in total.
 */
export function checkPlan(input: {
  loan: Loan;
  playbook: Playbook;
  instalments: ProposedInstalment[];
  targetCents: number;
  plansSoFar: number;
  today: string;
}): PolicyResult {
  const { playbook, instalments, targetCents, today } = input;
  const deny: string[] = [];
  const approval: string[] = [];

  if (instalments.length === 0) deny.push('plan has no instalments');
  const total = instalments.reduce((s, i) => s + i.amountCents, 0);
  if (total !== targetCents) deny.push(`plan totals ${total} but must cover ${targetCents}`);
  if (instalments.some((i) => i.amountCents <= 0)) deny.push('every instalment must be a positive amount');
  if (instalments.some((i) => i.dueDate < today)) deny.push('instalment dated in the past');
  const sorted = [...instalments].sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  if (sorted.some((i, k) => k > 0 && i.dueDate === sorted[k - 1]!.dueDate)) deny.push('two instalments on the same day');

  if (instalments.length > playbook.maxInstalments) {
    approval.push(`${instalments.length} instalments exceeds the limit of ${playbook.maxInstalments}`);
  }
  const first = sorted[0];
  if (first && first.amountCents < Math.ceil(targetCents * playbook.minFirstPaymentShare)) {
    approval.push(
      `first payment is ${Math.round((first.amountCents / targetCents) * 100)}% of the amount, below the ${Math.round(
        playbook.minFirstPaymentShare * 100,
      )}% minimum`,
    );
  }
  // Extension is measured from the later of the original due date and today.
  const anchor = maxDate(earliestDueForTarget(input.loan, today), today);
  const last = sorted[sorted.length - 1];
  if (last && daysBetween(anchor, last.dueDate) > playbook.maxExtensionDays) {
    approval.push(`last payment is ${daysBetween(anchor, last.dueDate)} days out, beyond ${playbook.maxExtensionDays}`);
  }
  if (input.plansSoFar >= playbook.maxPlansPerLoan) approval.push('loan already used its plans without approval');

  if (deny.length) return { verdict: 'deny', reasons: deny };
  if (approval.length) return { verdict: 'needs_approval', reasons: approval };
  return allow();
}

function earliestDueForTarget(loan: Loan, today: string): string {
  const overdue = overdueInstalments(loan, today)[0];
  return overdue?.dueDate ?? nextUnpaid(loan)?.dueDate ?? today;
}

/**
 * The amount a plan must cover: what is overdue, or for an early
 * schedule change, the next instalment.
 */
export function planTarget(loan: Loan, today: string): { cents: number; dueDate: string } {
  const overdue = overdueCents(loan, today);
  if (overdue > 0) return { cents: overdue, dueDate: overdueInstalments(loan, today)[0]!.dueDate };
  const next = nextUnpaid(loan);
  if (!next) return { cents: 0, dueDate: today };
  return { cents: next.amountCents - next.paidCents, dueDate: next.dueDate };
}

/** Latest date the agent may schedule a payment to without approval. */
export function latestAllowedDate(loan: Loan, playbook: Playbook, today: string): string {
  return addDays(maxDate(earliestDueForTarget(loan, today), today), playbook.maxExtensionDays);
}
