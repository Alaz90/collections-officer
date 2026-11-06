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
  /** Days since the last message to this borrower, or null if never. */
  daysSinceLastContact: number | null;
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
  if (loan.status === 'handed_over') {
    if (loan.hold && loan.hold !== 'restructuring') return out('wait', `with the officer (${loan.hold.replace('_', ' ')})`);
    if (borrower.optedOut) return out('wait', 'with the officer (opted out)');
    // Waiting for an officer call is no reason to go silent.
    if (input.daysSinceLastContact === null || input.daysSinceLastContact >= 7) return out('remind', 'weekly reminder while an officer call is pending');
    return out('wait', 'officer call pending');
  }

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
    // Silence alone is not a reason to hand over early: forgetful borrowers often pay without replying.
    if (input.unansweredMessages >= 4 && dpd > 14) return out('hand_over', `no reply to ${input.unansweredMessages} messages`);
    if (dpd > 45) return out('hand_over', `${dpd} days past due`);
    // Space follow-ups: no more than one every other day while waiting for a reply.
    if (input.daysSinceLastContact !== null && input.daysSinceLastContact < 2) return out('wait', 'contacted recently');
    if (input.activePlan) return out('remind', 'plan payment is late');
    return out('negotiate', `${dpd} ${dpd === 1 ? 'day' : 'days'} past due`);
  }

  // Not late yet: prevention. A reminder on the due date itself is still sent.
  if (input.contactedForCurrentInstalment && daysUntilDue !== 0) return out('wait', 'already contacted about this payment');
  if (daysUntilDue === 0 && input.daysSinceLastContact !== 0) return out('remind', 'due today');

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
