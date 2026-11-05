import type { Loan, Payment } from '@co/shared';
import type { CaseView, CollectionsAgent } from './agent/service.js';
import { addDays, daysBetween } from './domain/dates.js';
import { forecast } from './domain/forecast.js';
import { daysPastDue, outstandingCents, overdueCents, remaining } from './domain/loanMath.js';
import type { Store } from './ports.js';

/** Read models for the dashboard. Pure reads over the store; no side effects. */

export function lateness(loan: Loan, today: string): 'current' | '1-30' | '31-60' | '61+' {
  const dpd = daysPastDue(loan, today);
  return dpd === 0 ? 'current' : dpd <= 30 ? '1-30' : dpd <= 60 ? '31-60' : '61+';
}

export async function todayView(store: Store, agent: CollectionsAgent, lenderId: string, today: string) {
  const cases = await agent.preview(lenderId);
  const payments = await store.payments.list(lenderId);
  const plans = await store.plans.list(lenderId);
  const weekAgo = addDays(today, -7);
  const weekAhead = addDays(today, 7);

  const dueThisWeek = cases.reduce(
    (s, c) => s + c.loan.schedule.filter((i) => i.dueDate >= today && i.dueDate <= weekAhead).reduce((t, i) => t + remaining(i), 0),
    0,
  );
  const overdue = cases.reduce((s, c) => s + overdueCents(c.loan, today), 0);
  const collectedThisWeek = payments.filter((p) => p.receivedAt.slice(0, 10) >= weekAgo && p.status !== 'rejected').reduce((s, p) => s + p.amountCents, 0);
  const promised = plans
    .filter((p) => p.status === 'active')
    .reduce((s, p) => s + p.instalments.filter((i) => i.dueDate >= today).reduce((t, i) => t + i.amountCents, 0), 0);

  const row = (c: CaseView) => ({ ...caseRow(c), schedule: c.loan.schedule, paidLate: paidLateDates(c.loan, payments) });
  const callList = cases
    .filter((c) => c.loan.status === 'handed_over' || c.decision.action === 'hand_over')
    .sort((a, b) => b.decision.expectedAtRiskCents - a.decision.expectedAtRiskCents)
    .map(row);
  const rising = cases
    .filter((c) => daysPastDue(c.loan, today) === 0 && c.risk.level !== 'low')
    .sort((a, b) => b.risk.missProbability - a.risk.missProbability)
    .map(row);

  return {
    today,
    totals: { dueThisWeekCents: dueThisWeek, overdueCents: overdue, collectedThisWeekCents: collectedThisWeek, promisedCents: promised },
    callList,
    rising,
    plannedActions: countBy(cases.map((c) => c.decision.action)),
    cases: cases.map(row),
  };
}

/** Due dates of instalments completed after they were due. */
export function paidLateDates(loan: Loan, payments: Payment[]): string[] {
  const due = loan.schedule.map((i) => ({ date: i.dueDate, amount: i.amountCents, paid: 0 }));
  const late: string[] = [];
  for (const p of payments.filter((x) => x.loanId === loan.id && x.status !== 'rejected').sort((a, b) => a.receivedAt.localeCompare(b.receivedAt))) {
    let left = p.amountCents;
    for (const d of due) {
      if (left <= 0) break;
      const take = Math.min(left, d.amount - d.paid);
      if (take <= 0) continue;
      d.paid += take;
      left -= take;
      if (d.paid >= d.amount && p.receivedAt.slice(0, 10) > d.date) late.push(d.date);
    }
  }
  return late;
}

function caseRow(c: CaseView) {
  return {
    borrowerId: c.borrower.id,
    loanId: c.loan.id,
    name: c.borrower.name,
    region: c.borrower.region,
    sector: c.borrower.sector,
    // The stored status is refreshed by the daily run; show lateness as of now.
    status: c.loan.status === 'current' && daysPastDue(c.loan, todayOf(c)) > 0 ? 'late' : c.loan.status,
    hold: c.loan.hold ?? null,
    outstandingCents: outstandingCents(c.loan),
    risk: c.risk,
    nextAction: c.decision,
    rainfall: c.region,
  };
}

const todayOf = (c: CaseView) => c.region?.asOf ?? new Date().toISOString().slice(0, 10);

function countBy(xs: string[]) {
  return xs.reduce<Record<string, number>>((m, x) => ({ ...m, [x]: (m[x] ?? 0) + 1 }), {});
}

export async function portfolioView(store: Store, agent: CollectionsAgent, lenderId: string, today: string) {
  const cases = await agent.preview(lenderId);
  const outstanding = cases.reduce((s, c) => s + outstandingCents(c.loan), 0);
  const atRisk = (minDpd: number) =>
    cases.filter((c) => daysPastDue(c.loan, today) > minDpd).reduce((s, c) => s + outstandingCents(c.loan), 0);
  const buckets = countBy(cases.map((c) => lateness(c.loan, today)));
  const groups = new Map<string, { region: string; sector: string; loans: number; outstandingCents: number; overdueCents: number; avgMiss: number; rainfall: number | null; source?: string }>();
  for (const c of cases) {
    const key = `${c.borrower.region}|${c.borrower.sector}`;
    const g = groups.get(key) ?? { region: c.borrower.region, sector: c.borrower.sector, loans: 0, outstandingCents: 0, overdueCents: 0, avgMiss: 0, rainfall: c.region?.ratio ?? null, source: c.region?.source };
    g.loans++;
    g.outstandingCents += outstandingCents(c.loan);
    g.overdueCents += overdueCents(c.loan, today);
    g.avgMiss += c.risk.missProbability;
    groups.set(key, g);
  }
  const segments = [...groups.values()]
    .map((g) => ({ ...g, avgMiss: Math.round((g.avgMiss / g.loans) * 1000) / 1000 }))
    .sort((a, b) => b.avgMiss - a.avgMiss);
  return {
    loans: cases.length,
    outstandingCents: outstanding,
    par1: outstanding ? round(atRisk(0) / outstanding) : 0,
    par30: outstanding ? round(atRisk(30) / outstanding) : 0,
    buckets,
    segments,
    forecast: forecast(cases, today),
  };
}

export async function weeklyReport(store: Store, agent: CollectionsAgent, lenderId: string, today: string) {
  const from = addDays(today, -7);
  const inWeek = (iso: string) => iso.slice(0, 10) > from && iso.slice(0, 10) <= today;
  const [payments, plans, messages, runs] = await Promise.all([
    store.payments.list(lenderId),
    store.plans.list(lenderId),
    store.messages.list(lenderId),
    store.runs.list(lenderId),
  ]);
  const cases = await agent.preview(lenderId);
  const weekPlans = plans.filter((p) => inWeek(p.createdAt));
  const collected = payments.filter((p) => inWeek(p.receivedAt) && p.status !== 'rejected');
  const finished = plans.filter((p) => p.status === 'kept' || p.status === 'broken');
  const saved = plans.filter((p) => p.kind === 'schedule_change' && (p.status === 'active' || p.status === 'kept'));
  const handovers = runs.filter((r) => inWeek(r.at) && r.steps.some((s) => s.detail === 'hand_over'));
  const pending = {
    messages: messages.filter((m) => m.status === 'pending_approval').length,
    plans: plans.filter((p) => p.status === 'pending_approval').length,
  };
  const risingRegions = [...new Set(cases.filter((c) => c.region && c.region.ratio < 0.7).map((c) => c.borrower.region))];
  return {
    from,
    to: today,
    collectedCents: collected.reduce((s, p) => s + p.amountCents, 0),
    payments: collected.length,
    plansAgreed: weekPlans.filter((p) => ['active', 'kept', 'broken'].includes(p.status)).length,
    promiseKeptRate: finished.length ? round(finished.filter((p) => p.status === 'kept').length / finished.length) : null,
    loansSaved: saved.length,
    handedOver: new Set(handovers.map((r) => r.borrowerId)).size,
    messagesSent: messages.filter((m) => inWeek(m.at) && m.direction === 'out' && m.status === 'sent').length,
    decisionsNeeded: pending,
    risingRiskRegions: risingRegions,
    daysCovered: daysBetween(from, today),
  };
}

const round = (x: number) => Math.round(x * 1000) / 1000;
