import { beforeEach, describe, expect, it } from 'vitest';
import { CollectionsAgent } from '../src/agent/service.js';
import { OutboxChannel } from '../src/adapters/channels.js';
import { fixedClock, memoryStore, sequentialIds } from '../src/adapters/memory.js';
import { FakePayments } from '../src/adapters/payments.js';
import { TemplateAI } from '../src/adapters/templateAI.js';
import { FixedWeather } from '../src/adapters/weather.js';
import type { Deps, Lender } from '../src/ports.js';
import { borrower, loan, playbook } from './fixtures.js';

const LENDER: Lender = {
  id: 'l1',
  name: 'Demo Lender',
  playbook: playbook({ autonomy: 'auto' }),
  receivingAccounts: ['1000123456789'],
  timezoneOffsetHours: 3,
};

function setup(lender: Lender = LENDER) {
  const channel = new OutboxChannel();
  const payments = new FakePayments('http://localhost:8080');
  const weather = new FixedWeather({ Sidama: 0.4 });
  const clock = fixedClock('2026-11-10T07:00:00Z'); // 10:00 in Addis Ababa
  const deps: Deps = { store: memoryStore(), ai: new TemplateAI(), payments, channel, weather, clock, ids: sequentialIds() };
  return { deps, channel, payments, weather, clock, agent: new CollectionsAgent(deps), lender };
}

describe('collections agent', () => {
  let s: ReturnType<typeof setup>;

  beforeEach(async () => {
    s = setup();
    await s.deps.store.lenders.put(s.lender);
  });

  it('prevents: offers a farmer in a dry area a schedule change before the due date', async () => {
    await s.deps.store.borrowers.put(borrower());
    // Paid last month, 8 days late; next payment due in 10 days; rainfall at 40% of normal.
    await s.deps.store.loans.put(
      loan({
        schedule: [
          { dueDate: '2026-10-20', amountCents: 200_000, paidCents: 200_000 },
          { dueDate: '2026-11-20', amountCents: 200_000, paidCents: 0 },
        ],
      }),
    );
    await s.deps.store.payments.put({
      id: 'p0', lenderId: 'l1', loanId: 'loan1', amountCents: 200_000, source: 'link', reference: 'r0', status: 'verified', receivedAt: '2026-10-28T09:00:00Z',
    });
    const { cases } = await s.agent.dailyCycle('l1');
    expect(cases[0]!.decision.action).toBe('offer_schedule_change');
    expect(cases[0]!.risk.reasons.join(' ')).toMatch(/rainfall at 40%/);
    // No income date known yet, so the agent asks first.
    expect(s.channel.sent[0]!.text).toMatch(/When do you expect your harvest income/);

    // The farmer answers with an amount now and the harvest date: the plan follows it.
    await s.agent.handleReply('l1', 'b1', 'I can pay 1000 now and the rest on the 30th');
    const [plan] = await s.deps.store.plans.list('l1');
    expect(plan!.kind).toBe('schedule_change');
    expect(plan!.status).toBe('active');
    expect(plan!.instalments).toEqual([
      { dueDate: '2026-11-10', amountCents: 100_000 },
      { dueDate: '2026-11-30', amountCents: 100_000 },
    ]);
    const updated = await s.deps.store.loans.get('loan1');
    expect(updated!.status).toBe('in_plan');
    expect(updated!.schedule.map((i) => i.dueDate)).toEqual(['2026-10-20', '2026-11-10', '2026-11-30']);
    expect((await s.deps.store.borrowers.get('b1'))!.expectedIncomeDate).toBe('2026-11-30');
    expect(s.channel.sent.at(-1)!.text).toMatch(/plan is confirmed/);
  });

  it('recovers: counters a low offer, then the payment link closes the loop once', async () => {
    await s.deps.store.borrowers.put(borrower({ sector: 'trade', region: 'Addis Ababa' }));
    await s.deps.store.loans.put(loan());
    await s.agent.handleReply('l1', 'b1', 'I can only pay 200 now');
    const [plan] = await s.deps.store.plans.list('l1');
    expect(plan!.status).toBe('offered');
    expect(plan!.instalments[0]!.amountCents).toBe(60_000);
    expect(s.channel.sent.at(-1)!.text).toMatch(/We can agree this plan/);

    await s.agent.handleReply('l1', 'b1', 'ok I agree');
    const link = s.channel.sent.at(-1)!.text.match(/pay\/(\S+)/)![1]!;
    s.payments.markPaid(link);
    await s.agent.handlePayment('l1', link);
    await s.agent.handlePayment('l1', link); // duplicate webhook
    const payments = await s.deps.store.payments.list('l1');
    expect(payments).toHaveLength(1);
    expect(payments[0]!.amountCents).toBe(60_000);
  });

  it('hands over a borrower in hardship instead of negotiating', async () => {
    await s.deps.store.borrowers.put(borrower());
    await s.deps.store.loans.put(loan());
    const run = await s.agent.handleReply('l1', 'b1', 'My child is in hospital, I cannot pay');
    expect(run.outcome).toMatch(/handover_notice/);
    expect((await s.deps.store.loans.get('loan1'))!.status).toBe('handed_over');
  });

  it('refuses another plan after plans have broken: restructuring risk goes to the officer', async () => {
    await s.deps.store.borrowers.put(borrower({ sector: 'trade' }));
    await s.deps.store.loans.put(loan({ rescheduleCount: 2 }));
    for (const id of ['x1', 'x2']) {
      await s.deps.store.plans.put({
        id, lenderId: 'l1', loanId: 'loan1', kind: 'payment_plan', instalments: [{ dueDate: '2026-10-01', amountCents: 1 }], status: 'broken',
        realism: { ok: true, score: 0.8, reasons: [] }, createdAt: '2026-09-01T00:00:00Z',
      });
    }
    const run = await s.agent.handleReply('l1', 'b1', 'I can pay 1000 now and the rest next week');
    expect(run.outcome).toMatch(/realism|officer/);
    expect((await s.deps.store.loans.get('loan1'))!.status).toBe('handed_over');
  });

  it('checks receipts: accepts a valid one and catches a reused transaction number', async () => {
    await s.deps.store.borrowers.put(borrower());
    await s.deps.store.loans.put(loan());
    const fields = { transactionId: 'FT2531', amountCents: 200_000, date: '2026-11-09', sender: 'Abebe', receivingAccount: '1000 1234 56789', provider: 'CBE' };
    s.deps.ai.readReceipt = async () => fields;
    const ok = await s.agent.handleReceipt('l1', 'b1', { mimeType: 'image/jpeg', base64: '' });
    expect(ok.problems).toEqual([]);
    const again = await s.agent.handleReceipt('l1', 'b1', { mimeType: 'image/jpeg', base64: '' });
    expect(again.problems).toContain('transaction number was already used');
  });

  it('holds sensitive messages for approval when the lender asks for it', async () => {
    const strict = setup({ ...LENDER, playbook: playbook({ autonomy: 'approve_sensitive' }) });
    await strict.deps.store.lenders.put(strict.lender);
    await strict.deps.store.borrowers.put(borrower({ sector: 'trade' }));
    await strict.deps.store.loans.put(loan());
    await strict.agent.dailyCycle('l1');
    const [m] = await strict.deps.store.messages.list('l1');
    expect(m!.status).toBe('pending_approval');
    expect(strict.channel.sent).toHaveLength(0);
    await strict.agent.approveMessage('l1', m!.id);
    expect(strict.channel.sent).toHaveLength(1);
  });

  it('approving a plan sends its offer without a second approval', async () => {
    const strict = setup({ ...LENDER, playbook: playbook({ autonomy: 'approve_sensitive' }) });
    await strict.deps.store.lenders.put(strict.lender);
    await strict.deps.store.borrowers.put(borrower({ sector: 'trade' }));
    await strict.deps.store.loans.put(loan());
    await strict.deps.store.plans.put({
      id: 'p1', lenderId: 'l1', loanId: 'loan1', kind: 'payment_plan', instalments: [{ dueDate: '2026-11-20', amountCents: 60_000 }, { dueDate: '2026-12-20', amountCents: 140_000 }],
      status: 'pending_approval', realism: { ok: true, score: 0.8, reasons: [] }, createdAt: '2026-11-10T07:00:00Z',
    });
    await strict.agent.approvePlan('l1', 'p1');
    expect(strict.channel.sent).toHaveLength(1);
    const [m] = await strict.deps.store.messages.list('l1');
    expect(m!.status).toBe('sent');
  });

  it('never messages outside contact hours', async () => {
    s.clock.set('2026-11-10T19:00:00Z'); // 22:00 local
    await s.deps.store.borrowers.put(borrower({ sector: 'trade' }));
    await s.deps.store.loans.put(loan());
    await s.agent.dailyCycle('l1');
    expect(s.channel.sent).toHaveLength(0);
    expect((await s.deps.store.messages.list('l1'))[0]!.status).toBe('blocked');
  });
});
