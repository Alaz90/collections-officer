import type { Loan, RiskAssessment } from '@co/shared';
import { addDays, daysBetween } from './dates.js';
import { remaining } from './loanMath.js';

export interface ForecastBucket {
  label: string;
  from: string;
  to: string;
  scheduledCents: number;
  expectedCents: number;
  /** 80% interval for the expected amount. */
  lowCents: number;
  highCents: number;
}

/**
 * Cash forecast: each unpaid instalment in the window counts with the
 * likelihood it is paid, from the loan's risk score. Overdue amounts count
 * at a lower likelihood. The interval treats instalments as independent
 * payments (a simplification, stated in the UI).
 */
export function forecast(
  cases: Array<{ loan: Loan; risk: RiskAssessment }>,
  today: string,
  windows: number[] = [30, 60, 90],
): ForecastBucket[] {
  return windows.map((days, k) => {
    const from = k === 0 ? today : addDays(today, windows[k - 1]! + 1);
    const to = addDays(today, days);
    let scheduled = 0;
    let expected = 0;
    let variance = 0;
    for (const { loan, risk } of cases) {
      if (loan.status === 'closed' || loan.status === 'defaulted') continue;
      for (const i of loan.schedule) {
        const left = remaining(i);
        if (left === 0) continue;
        const overdue = i.dueDate < today;
        // Overdue money is counted only in the first window.
        if (overdue ? k !== 0 : i.dueDate < from || i.dueDate > to) continue;
        const ahead = Math.max(0, daysBetween(today, i.dueDate));
        // Risk fades a little with distance: today's score says most about the next payment.
        const pMiss = Math.min(0.95, risk.missProbability * (overdue ? 1.3 : 1) * (1 - Math.min(ahead, 90) / 300));
        const p = 1 - pMiss;
        scheduled += left;
        expected += left * p;
        variance += left * left * p * (1 - p);
      }
    }
    const sd = Math.sqrt(variance);
    return {
      label: `${days} days`,
      from,
      to,
      scheduledCents: Math.round(scheduled),
      expectedCents: Math.round(expected),
      lowCents: Math.max(0, Math.round(expected - 1.28 * sd)),
      highCents: Math.min(Math.round(scheduled), Math.round(expected + 1.28 * sd)),
    };
  });
}
