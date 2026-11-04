import type { Loan, Plan } from '@co/shared';
import { addDays } from './dates.js';
import { overdueInstalments, nextUnpaid, remaining } from './loanMath.js';

/**
 * Applies an agreed plan to the loan: the instalments the plan covers are
 * replaced by the plan's instalments. Paid amounts are kept; the rest of the
 * schedule is untouched.
 */
export function applyPlanToLoan(loan: Loan, plan: Pick<Plan, 'instalments' | 'kind'>, today: string): Loan {
  const covered = new Set(
    (plan.kind === 'payment_plan' ? overdueInstalments(loan, today) : [nextUnpaid(loan)].filter(Boolean)).map(
      (i) => i!.dueDate,
    ),
  );
  const kept = loan.schedule.filter((i) => !covered.has(i.dueDate) || remaining(i) === 0);
  // Fully paid instalments that were "covered" stay as history; the unpaid
  // part moves into the plan, so shrink covered partially-paid ones to what was paid.
  const shrunk = loan.schedule
    .filter((i) => covered.has(i.dueDate) && remaining(i) > 0 && i.paidCents > 0)
    .map((i) => ({ ...i, amountCents: i.paidCents }));
  const added = plan.instalments.map((p) => ({ dueDate: p.dueDate, amountCents: p.amountCents, paidCents: 0 }));
  const schedule = mergeSameDay([...kept, ...shrunk, ...added].sort((a, b) => a.dueDate.localeCompare(b.dueDate)));
  return { ...loan, schedule, status: 'in_plan', rescheduleCount: loan.rescheduleCount + 1 };
}

function mergeSameDay(schedule: Loan['schedule']): Loan['schedule'] {
  const out: Loan['schedule'] = [];
  for (const i of schedule) {
    const last = out[out.length - 1];
    if (last && last.dueDate === i.dueDate) {
      last.amountCents += i.amountCents;
      last.paidCents += i.paidCents;
    } else out.push({ ...i });
  }
  return out;
}

/** Grace period before a missed plan instalment counts as a broken plan. */
export const PLAN_GRACE_DAYS = 3;

/** Decides whether an active plan has been kept or broken by `today`. */
export function evaluatePlan(plan: Plan, loan: Loan, today: string): Plan['status'] {
  if (plan.status !== 'active') return plan.status;
  const byDate = new Map(loan.schedule.map((i) => [i.dueDate, i]));
  const items = plan.instalments.map((p) => byDate.get(p.dueDate));
  if (items.every((i) => i && remaining(i) === 0)) return 'kept';
  const missed = plan.instalments.some((p) => {
    const i = byDate.get(p.dueDate);
    return i && remaining(i) > 0 && addDays(p.dueDate, PLAN_GRACE_DAYS) < today;
  });
  return missed ? 'broken' : 'active';
}
