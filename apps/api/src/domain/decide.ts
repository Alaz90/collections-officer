import type { ActionKind, Borrower, Loan, Playbook, RiskAssessment } from '@co/shared';
import { daysBetween } from './dates.js';
import { daysPastDue, nextUnpaid, outstandingCents, remaining } from './loanMath.js';
import { MAX_RESCHEDULES } from './realism.js';

/**
 * Next best action for one borrower in the daily cycle. Rules a reviewer can
 * read; Gemini then writes the message for whichever action is chosen.
 */

export interface DecisionInput {
  loan: Loan;
  borrower: Borrower;
  risk: RiskAssessment;
  playbook: Playbook;
  brokenPlans: number;
  activePlan: boolean;
  unansweredMessages: number;
  /** Rainfall ratio for farming loans, null otherwise. */
  rainfallRatio: number | null;
  /** Whether the agent already contacted this borrower about this instalment. */
  contactedForCurrentInstalment: boolean;
  today: string;
}

export interface Decision {
  action: ActionKind;
  reason: string;
  /** Expected amount at stake, used to rank the officer's call list. */
  expectedAtRiskCents: number;
}

export function decide(input: DecisionInput): Decision {
  const { loan, borrower, risk, playbook, today } = input;
  const atRisk = Math.round(outstandingCents(loan) * risk.missProbability);
  const out = (action: ActionKind, reason: string): Decision => ({ action, reason, expectedAtRiskCents: atRisk });

  if (loan.status === 'closed' || loan.status === 'defaulted') return out('wait', 'loan is closed');
  if (loan.status === 'handed_over') return out('wait', 'with the officer');

  const next = nextUnpaid(loan);
  if (!next || remaining(next) === 0) return out('wait', 'nothing due');

  const dpd = daysPastDue(loan, today);
  const daysUntilDue = daysBetween(today, next.dueDate);

  if (borrower.optedOut) {
    return dpd > 0 ? out('hand_over', 'late and opted out of automated messages') : out('wait', 'opted out');
  }

  // Late.
  if (dpd > 0) {
    const exhausted = input.brokenPlans >= 2 || loan.rescheduleCount >= MAX_RESCHEDULES;
    if (exhausted) return out('hand_over', 'plans have not held; another one would only delay the problem');
    if (input.unansweredMessages >= 3) return out('hand_over', 'no reply to three messages');
    if (dpd > 30) return out('hand_over', `${dpd} days past due`);
    if (input.activePlan) return out('remind', 'plan payment is late');
    return out('negotiate', `${dpd} days past due`);
  }

  // Not late yet: prevention.
  if (input.contactedForCurrentInstalment) return out('wait', 'already contacted about this payment');

  const dry = input.rainfallRatio !== null && input.rainfallRatio < 0.7;
  if (borrower.sector === 'farming' && dry && risk.level !== 'low' && daysUntilDue <= 14 && !input.activePlan) {
    return out('offer_schedule_change', 'dry season in their area and repayment risk is rising');
  }
  if (risk.level === 'high' && daysUntilDue <= 10) return out('early_checkin', 'high risk before the due date');
  if (risk.level === 'medium' && daysUntilDue <= 7) return out('early_checkin', 'repayment risk is rising');
  if (daysUntilDue <= playbook.remindDaysBefore) return out('remind', `due in ${daysUntilDue} days`);

  return out('wait', 'not due yet');
}

/** Officer call list: cases handed over, largest expected loss first. */
export function rankCallList<T extends { decision: Decision }>(cases: T[]): T[] {
  return cases
    .filter((c) => c.decision.action === 'hand_over')
    .sort((a, b) => b.decision.expectedAtRiskCents - a.decision.expectedAtRiskCents);
}
