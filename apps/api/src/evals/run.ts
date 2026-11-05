import { DEFAULT_PLAYBOOK } from '@co/shared';
import { CollectionsAgent } from '../agent/service.js';
import { OutboxChannel } from '../adapters/channels.js';
import { fixedClock, memoryStore, sequentialIds } from '../adapters/memory.js';
import { FakePayments } from '../adapters/payments.js';
import { FixedWeather } from '../adapters/weather.js';
import { buildPlan } from '../domain/negotiation.js';
import { checkPlan, checkTone, planTarget } from '../domain/policy.js';
import type { AI, Lender } from '../ports.js';
import { AMOUNT_DUE, EVAL_TODAY, RECEIPTS, REPLIES, TONE } from './dataset.js';

export interface EvalReport {
  reader: string;
  replies: { total: number; intentAccuracy: number; amountAccuracy: number; dateRecall: number; falsePaid: number; byLanguage: Record<string, number> };
  adversarial: { total: number; neverMarkedPaid: boolean; plansStayInPolicy: boolean; failures: string[] };
  receipts: { total: number; correct: number; failures: string[] };
  tone: { total: number; correct: number; failures: string[] };
  failures: string[];
}

const LOAN = {
  id: 'L1',
  lenderId: 'l1',
  borrowerId: 'b1',
  principalCents: 600_000,
  schedule: [
    { dueDate: '2026-10-20', amountCents: 200_000, paidCents: 0 },
    { dueDate: '2026-11-20', amountCents: 200_000, paidCents: 0 },
  ],
  status: 'late' as const,
  rescheduleCount: 0,
  createdAt: '2026-09-20',
};

/** Runs the whole suite against one reply reader (Gemini or the rule-based fallback). */
export async function runEvals(ai: AI, readerName: string): Promise<EvalReport> {
  const failures: string[] = [];
  let intentOk = 0;
  let amountTotal = 0;
  let amountOk = 0;
  let dateTotal = 0;
  let dateOk = 0;
  let falsePaid = 0;
  const lang: Record<string, { n: number; ok: number }> = {};
  const advFailures: string[] = [];
  let neverMarkedPaid = true;
  let plansStayInPolicy = true;

  for (const c of REPLIES) {
    const r = await ai.readReply(c.text, { today: EVAL_TODAY, amountDue: AMOUNT_DUE, caseSummary: '' });
    const l = (lang[c.lang] ??= { n: 0, ok: 0 });
    l.n++;
    const intentMatches = r.intent === c.intent || (c.adversarial && r.intent !== 'paid' && c.intent === 'other');
    if (intentMatches) {
      intentOk++;
      l.ok++;
    } else failures.push(`${c.id}: intent ${r.intent}, expected ${c.intent}`);
    if (r.intent === 'paid' && c.intent !== 'paid') falsePaid++;
    if (c.offerNowCents !== undefined && c.offerNowCents !== null) {
      amountTotal++;
      if (r.offerNowCents === c.offerNowCents) amountOk++;
      else failures.push(`${c.id}: amount ${r.offerNowCents}, expected ${c.offerNowCents}`);
    }
    for (const d of c.dates ?? []) {
      dateTotal++;
      if (r.proposedInstalments.some((p) => p.dueDate === d)) dateOk++;
      else failures.push(`${c.id}: missing date ${d}`);
    }
    if (c.adversarial) {
      if (r.intent === 'paid') {
        neverMarkedPaid = false;
        advFailures.push(`${c.id}: read as paid`);
      }
      // Whatever the reading, the plan that reaches the borrower must pass the policy layer.
      const built = buildPlan({ loan: LOAN, playbook: DEFAULT_PLAYBOOK, reading: r, today: EVAL_TODAY });
      if (built.kind !== 'nothing_to_plan') {
        const check = checkPlan({ loan: LOAN, playbook: DEFAULT_PLAYBOOK, instalments: built.instalments, targetCents: planTarget(LOAN, EVAL_TODAY).cents, plansSoFar: 0, today: EVAL_TODAY });
        if (check.verdict === 'allow' && built.instalments[0]!.amountCents < Math.ceil(planTarget(LOAN, EVAL_TODAY).cents * DEFAULT_PLAYBOOK.minFirstPaymentShare)) {
          plansStayInPolicy = false;
          advFailures.push(`${c.id}: plan below the playbook minimum was allowed`);
        }
      }
    }
  }

  // Receipts: the checks run in code on the extracted fields.
  const receiptFailures: string[] = [];
  let receiptOk = 0;
  for (const rc of RECEIPTS) {
    const store = memoryStore();
    const lender: Lender = { id: 'l1', name: 'Eval', playbook: DEFAULT_PLAYBOOK, receivingAccounts: ['1000123456789', '0911000000'], timezoneOffsetHours: 3 };
    await store.lenders.put(lender);
    await store.loans.put(LOAN);
    for (const ref of rc.used ?? []) {
      await store.payments.put({ id: ref, lenderId: 'l1', loanId: 'L1', amountCents: 1, source: 'receipt', reference: ref, status: 'verified_by_receipt', receivedAt: '2026-11-01T00:00:00Z' });
    }
    const agent = new CollectionsAgent({ store, ai, payments: new FakePayments('x'), channel: new OutboxChannel(), weather: new FixedWeather({}), clock: fixedClock(`${EVAL_TODAY}T07:00:00Z`), ids: sequentialIds() });
    const problems = await agent.receiptProblems(lender, LOAN, rc.fields);
    const ok = problems.length === 0;
    const right = ok === rc.expectOk && (!rc.expectProblem || problems.some((p) => p.includes(rc.expectProblem!)));
    if (right) receiptOk++;
    else receiptFailures.push(`${rc.id}: got [${problems.join('; ')}]`);
  }

  const toneFailures: string[] = [];
  let toneOk = 0;
  for (const t of TONE) {
    const allowed = checkTone(t.text).verdict === 'allow';
    if (allowed === t.allowed) toneOk++;
    else toneFailures.push(`"${t.text.slice(0, 40)}…" ${allowed ? 'allowed' : 'blocked'}`);
  }

  const round = (x: number) => Math.round(x * 1000) / 1000;
  return {
    reader: readerName,
    replies: {
      total: REPLIES.length,
      intentAccuracy: round(intentOk / REPLIES.length),
      amountAccuracy: amountTotal ? round(amountOk / amountTotal) : 1,
      dateRecall: dateTotal ? round(dateOk / dateTotal) : 1,
      falsePaid,
      byLanguage: Object.fromEntries(Object.entries(lang).map(([k, v]) => [k, round(v.ok / v.n)])),
    },
    adversarial: { total: REPLIES.filter((r) => r.adversarial).length, neverMarkedPaid, plansStayInPolicy, failures: advFailures },
    receipts: { total: RECEIPTS.length, correct: receiptOk, failures: receiptFailures },
    tone: { total: TONE.length, correct: toneOk, failures: toneFailures },
    failures,
  };
}
