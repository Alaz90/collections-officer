import { describe, expect, it } from 'vitest';
import { decide } from '../src/domain/decide.js';
import { applyPayment, daysPastDue, overdueCents, repaymentHistory } from '../src/domain/loanMath.js';
import { buildPlan, earlyScheduleChange, split } from '../src/domain/negotiation.js';
import { checkContact, checkPlan, checkTone } from '../src/domain/policy.js';
import { checkRealism } from '../src/domain/realism.js';
import { assessRisk, collectSignals, DEFAULT_WEIGHTS, fitWeights, type RiskSignals } from '../src/domain/risk.js';
import { borrower, loan, payment, playbook, TODAY } from './fixtures.js';

const calm: RiskSignals = {
  daysPastDue: 0,
  lateShare: 0,
  lastWasPartial: false,
  brokenPlans: 0,
  unansweredMessages: 0,
  activePlan: false,
  rainfallRatio: null,
};

describe('loan math', () => {
  it('finds the overdue amount and days past due', () => {
    const l = loan();
    expect(overdueCents(l, TODAY)).toBe(200_000);
    expect(daysPastDue(l, TODAY)).toBe(21);
  });

  it('applies payments to the oldest instalment first and closes paid loans', () => {
    const l = applyPayment(loan(), 250_000);
    expect(l.schedule.map((i) => i.paidCents)).toEqual([200_000, 200_000, 50_000]);
    expect(applyPayment(l, 150_000).status).toBe('closed');
  });

  it('replays payments to learn lateness and partial payments', () => {
    const l = loan({
      schedule: [
        { dueDate: '2026-09-20', amountCents: 200_000, paidCents: 200_000 },
        { dueDate: '2026-10-20', amountCents: 200_000, paidCents: 50_000 },
        { dueDate: '2026-11-20', amountCents: 200_000, paidCents: 0 },
      ],
    });
    const h = repaymentHistory(
      l,
      [
        payment({ id: 'a', amountCents: 200_000, receivedAt: '2026-09-25T00:00:00Z' }),
        payment({ id: 'b', amountCents: 50_000, receivedAt: '2026-10-21T00:00:00Z' }),
      ],
      TODAY,
    );
    expect(h.paidCount).toBe(1);
    expect(h.paidLateCount).toBe(1);
    expect(h.avgDaysLate).toBe(5);
    expect(h.lastWasPartial).toBe(true);
    expect(h.typicalPaymentCents).toBe(50_000);
  });
});

describe('risk score', () => {
  it('is low with a clean record and explains itself', () => {
    const r = assessRisk(calm);
    expect(r.level).toBe('low');
    expect(r.reasons).toEqual(['good repayment record']);
  });

  it('rises with lateness, partial payment and dry weather, with the reasons named', () => {
    const r = assessRisk({ ...calm, lateShare: 0.5, lastWasPartial: true, rainfallRatio: 0.4 });
    expect(r.level).not.toBe('low');
    expect(r.reasons.join(' ')).toMatch(/rainfall at 40% of normal/);
    expect(r.reasons.join(' ')).toMatch(/partial/);
  });

  it('ignores weather for loans not tied to farming', () => {
    const signals = collectSignals({
      loan: loan(),
      borrower: borrower({ sector: 'trade' }),
      history: { paidCount: 1, paidLateCount: 0, avgDaysLate: 0, lastWasPartial: false, typicalPaymentCents: 0 },
      brokenPlans: 0,
      activePlan: false,
      unansweredMessages: 0,
      region: { region: 'Sidama', recentMm: 10, normalMm: 100, ratio: 0.1, asOf: TODAY },
      today: TODAY,
    });
    expect(signals.rainfallRatio).toBeNull();
  });

  it('refits weights towards what actually predicts missed payments', () => {
    // In this lender's data, partial payments predict misses strongly.
    const samples = Array.from({ length: 200 }, (_, i) => {
      const partial = i % 2 === 0;
      return { signals: { ...calm, lastWasPartial: partial }, missed: partial ? i % 10 !== 0 : i % 10 === 1 };
    });
    const fitted = fitWeights(samples);
    expect(fitted.lastWasPartial).toBeGreaterThan(DEFAULT_WEIGHTS.lastWasPartial);
  });
});

describe('policy layer', () => {
  it('blocks threats and mentions of third parties', () => {
    expect(checkTone('Please pay or we will tell your family.').verdict).toBe('deny');
    expect(checkTone('We may take legal action.').verdict).toBe('deny');
    expect(checkTone('Hi Abebe, a friendly reminder that 2,000 birr is due on Friday.').verdict).toBe('allow');
  });

  it('respects opt-out, contact hours and the daily cap', () => {
    const base = { borrower: borrower(), playbook: playbook(), localHour: 10, sentToday: 0 };
    expect(checkContact(base).verdict).toBe('allow');
    expect(checkContact({ ...base, localHour: 22 }).reasons[0]).toMatch(/contact hours/);
    expect(checkContact({ ...base, sentToday: 1 }).reasons[0]).toMatch(/daily contact limit/);
    expect(checkContact({ ...base, borrower: borrower({ optedOut: true }) }).verdict).toBe('deny');
  });

  it('allows a plan inside the playbook', () => {
    const r = checkPlan({
      loan: loan(),
      playbook: playbook(),
      instalments: [
        { dueDate: TODAY, amountCents: 60_000 },
        { dueDate: '2026-11-17', amountCents: 140_000 },
      ],
      targetCents: 200_000,
      plansSoFar: 0,
      today: TODAY,
    });
    expect(r).toEqual({ verdict: 'allow', reasons: [] });
  });

  it('sends a plan outside the playbook to a manager, and refuses broken ones', () => {
    const tooLow = checkPlan({
      loan: loan(),
      playbook: playbook(),
      instalments: [
        { dueDate: TODAY, amountCents: 10_000 },
        { dueDate: '2026-11-17', amountCents: 190_000 },
      ],
      targetCents: 200_000,
      plansSoFar: 0,
      today: TODAY,
    });
    expect(tooLow.verdict).toBe('needs_approval');
    expect(tooLow.reasons[0]).toMatch(/below the 30% minimum/);

    const wrongTotal = checkPlan({
      loan: loan(),
      playbook: playbook(),
      instalments: [{ dueDate: TODAY, amountCents: 100_000 }],
      targetCents: 200_000,
      plansSoFar: 0,
      today: TODAY,
    });
    expect(wrongTotal.verdict).toBe('deny');
  });
});

describe('negotiation', () => {
  it('splits amounts exactly', () => {
    expect(split(100, ['a', 'b', 'c']).map((i) => i.amountCents)).toEqual([33, 33, 34]);
  });

  it('accepts an offer above the minimum and schedules the rest within the limit', () => {
    const out = buildPlan({
      loan: loan(),
      playbook: playbook(),
      reading: { offerNowCents: 80_000, proposedInstalments: [] },
      today: TODAY,
    });
    expect(out.kind).toBe('accept');
    if (out.kind === 'nothing_to_plan') return;
    expect(out.instalments[0]).toEqual({ dueDate: TODAY, amountCents: 80_000 });
    expect(out.instalments.reduce((s, i) => s + i.amountCents, 0)).toBe(200_000);
    const check = checkPlan({
      loan: loan(),
      playbook: playbook(),
      instalments: out.instalments,
      targetCents: 200_000,
      plansSoFar: 0,
      today: TODAY,
    });
    expect(check.verdict).toBe('allow');
  });

  it('counters a low offer at the playbook minimum', () => {
    const out = buildPlan({
      loan: loan(),
      playbook: playbook(),
      reading: { offerNowCents: 20_000, proposedInstalments: [] },
      today: TODAY,
    });
    expect(out.kind).toBe('counter');
    if (out.kind !== 'counter') return;
    expect(out.instalments[0]!.amountCents).toBe(60_000);
  });

  it('moves part of the next payment to the income date for an early change', () => {
    const notLate = loan({
      schedule: [{ dueDate: '2026-11-20', amountCents: 200_000, paidCents: 0 }],
    });
    const plan = earlyScheduleChange({ loan: notLate, playbook: playbook(), incomeDate: '2026-11-30', today: TODAY });
    expect(plan).toEqual([
      { dueDate: '2026-11-20', amountCents: 100_000 },
      { dueDate: '2026-11-30', amountCents: 100_000 },
    ]);
  });
});

describe('realism check', () => {
  const history = { paidCount: 2, paidLateCount: 0, avgDaysLate: 0, lastWasPartial: false, typicalPaymentCents: 100_000 };

  it('passes a plan that fits the history', () => {
    const r = checkRealism({
      instalments: [{ dueDate: TODAY, amountCents: 100_000 }],
      history,
      pastPlans: [],
      rescheduleCount: 0,
      daysPastDue: 5,
    });
    expect(r.ok).toBe(true);
  });

  it('refuses another plan after broken ones and repeated rescheduling', () => {
    const r = checkRealism({
      instalments: [{ dueDate: TODAY, amountCents: 100_000 }],
      history,
      pastPlans: [{ status: 'broken' }, { status: 'broken' }],
      rescheduleCount: 2,
      daysPastDue: 40,
    });
    expect(r.ok).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/delay the problem/);
  });
});

describe('next best action', () => {
  const base = {
    borrower: borrower(),
    playbook: playbook(),
    brokenPlans: 0,
    activePlan: false,
    unansweredMessages: 0,
    rainfallRatio: null,
    contactedForCurrentInstalment: false,
    today: TODAY,
  };
  const notLate = loan({ schedule: [{ dueDate: '2026-11-20', amountCents: 200_000, paidCents: 0 }] });

  it('offers a schedule change early to a farmer in a dry area', () => {
    const d = decide({
      ...base,
      loan: notLate,
      rainfallRatio: 0.4,
      risk: { missProbability: 0.4, level: 'medium', reasons: [] },
    });
    expect(d.action).toBe('offer_schedule_change');
  });

  it('waits for a low-risk borrower who is not due soon', () => {
    const d = decide({ ...base, loan: notLate, risk: { missProbability: 0.05, level: 'low', reasons: [] } });
    expect(d.action).toBe('wait');
  });

  it('negotiates when late, and hands over when plans have not held', () => {
    const risk = { missProbability: 0.7, level: 'high' as const, reasons: [] };
    expect(decide({ ...base, loan: loan(), risk }).action).toBe('negotiate');
    expect(decide({ ...base, loan: loan(), risk, brokenPlans: 2 }).action).toBe('hand_over');
  });
});
