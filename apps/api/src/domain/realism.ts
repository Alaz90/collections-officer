import type { Plan } from '@co/shared';
import type { RepaymentHistory } from './loanMath.js';
import type { ProposedInstalment } from './policy.js';

/**
 * Realism check: is this plan likely to be kept, or would it only push the
 * problem forward? Stops the agent from hiding bad loans by rescheduling
 * them again and again ("evergreening").
 */

export interface RealismInput {
  instalments: ProposedInstalment[];
  history: RepaymentHistory;
  pastPlans: Pick<Plan, 'status'>[];
  rescheduleCount: number;
  daysPastDue: number;
}

export interface RealismResult {
  ok: boolean;
  /** Rough likelihood the plan is kept (0..1). */
  score: number;
  reasons: string[];
}

export const MAX_RESCHEDULES = 2;

export function checkRealism(input: RealismInput): RealismResult {
  const reasons: string[] = [];
  let score = 0.8;

  const finished = input.pastPlans.filter((p) => p.status === 'kept' || p.status === 'broken');
  const broken = finished.filter((p) => p.status === 'broken').length;
  if (broken > 0) {
    score -= 0.25 * broken;
    reasons.push(`${broken} earlier plan${broken > 1 ? 's were' : ' was'} broken`);
  }
  const kept = finished.length - broken;
  if (kept > 0) score += 0.05 * kept;

  if (input.rescheduleCount >= MAX_RESCHEDULES) {
    score -= 0.3;
    reasons.push(`loan already rescheduled ${input.rescheduleCount} times`);
  }

  // A plan asking for far more per payment than the borrower usually pays.
  const typical = input.history.typicalPaymentCents;
  const largest = Math.max(...input.instalments.map((i) => i.amountCents));
  if (typical > 0 && largest > typical * 2.5) {
    score -= 0.2;
    reasons.push('instalments are much larger than this borrower usually pays');
  }

  if (input.daysPastDue > 60) {
    score -= 0.2;
    reasons.push(`${input.daysPastDue} days past due`);
  }

  score = Math.max(0, Math.min(1, Math.round(score * 100) / 100));
  const ok = score >= 0.45 && input.rescheduleCount < MAX_RESCHEDULES + 1;
  if (ok && reasons.length === 0) reasons.push('fits this borrower’s payment history');
  if (!ok) reasons.push('likely to delay the problem rather than solve it');
  return { ok, score, reasons };
}
