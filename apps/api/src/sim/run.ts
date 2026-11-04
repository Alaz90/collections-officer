import { DEFAULT_PLAYBOOK, type Loan, type Plan } from '@co/shared';
import { CollectionsAgent } from '../agent/service.js';
import { OutboxChannel } from '../adapters/channels.js';
import { fixedClock, memoryStore, sequentialIds } from '../adapters/memory.js';
import { FakePayments } from '../adapters/payments.js';
import { TemplateAI } from '../adapters/templateAI.js';
import { addDays, daysBetween } from '../domain/dates.js';
import { applyPayment, daysPastDue, overdueCents, remaining } from '../domain/loanMath.js';
import type { Lender, Weather } from '../ports.js';
import { makePortfolio, rainfallOn, rng, Wallets, type Assumptions, type Rng, type SimBorrower } from './world.js';

export interface SimResult {
  strategy: 'baseline' | 'agent';
  borrowers: number;
  dueCents: number;
  collectedCents: number;
  collectionRate: number;
  defaults: number;
  defaultRate: number;
  outreachMessages: number;
  messagesPer1000Birr: number;
  handovers: number;
  plansAgreed: number;
  plansKept: number;
  planKeptRate: number | null;
}

export const SIM_START = '2026-06-01';
/** Long enough for the last instalment plus 45 days. */
export const SIM_DAYS = 180;

const round = (x: number) => Math.round(x * 1000) / 1000;
const instalmentOf = (w: SimBorrower) => w.loan.schedule[0]!.amountCents;

/** Everything due by `day` that is still unpaid. */
const dueNow = (loan: Loan, day: string) => loan.schedule.filter((i) => i.dueDate <= day).reduce((s, i) => s + remaining(i), 0);

/** Borrowers far behind engage less: a common pattern in collections. */
const fatigue = (dpd: number) => (dpd > 30 ? 0.4 : 1);

/** Chance of paying everything due today, when the money is there. */
function paysInFull(w: SimBorrower, reminded: boolean, dpd: number): number {
  const p = { reliable: reminded || dpd > 0 ? 0.9 : 0.5, forgetful: reminded ? 0.8 : 0.05, struggling: reminded ? 0.6 : 0.1, evasive: reminded ? 0.2 : 0.03 }[w.traits.persona];
  return p * fatigue(dpd);
}

function isDefault(loan: Loan, end: string, instalment: number) {
  return daysPastDue(loan, end) >= 60 && overdueCents(loan, end) >= instalment / 2;
}

function finish(strategy: SimResult['strategy'], loans: Loan[], world: SimBorrower[], outreach: number, extra: Partial<SimResult>): SimResult {
  const end = addDays(SIM_START, SIM_DAYS);
  const inst = new Map(world.map((w) => [w.loan.id, instalmentOf(w)]));
  const dueCents = loans.reduce((s, l) => s + l.principalCents, 0);
  const collectedCents = loans.reduce((s, l) => s + l.schedule.reduce((t, i) => t + i.paidCents, 0), 0);
  const defaults = loans.filter((l) => isDefault(l, end, inst.get(l.id)!)).length;
  return {
    strategy,
    borrowers: loans.length,
    dueCents,
    collectedCents,
    collectionRate: round(collectedCents / dueCents),
    defaults,
    defaultRate: round(defaults / loans.length),
    outreachMessages: outreach,
    messagesPer1000Birr: round(outreach / (collectedCents / 100_000)),
    handovers: 0,
    plansAgreed: 0,
    plansKept: 0,
    planKeptRate: null,
    ...extra,
  };
}

/** Officer call: collects what the borrower can pay towards the overdue amount, half the time. */
function officerCall(r: Rng, cap: number, overdue: number): number {
  if (overdue <= 0 || cap < overdue * 0.2 || !r.chance(0.5)) return 0;
  return Math.min(overdue, cap);
}

const callsPerDay = (a: Assumptions, n: number) => Math.max(1, Math.round((a.officerCallsPerDay * n) / 200));

// ---------------------------------------------------------------------------
// Baseline: fixed reminders, no negotiation, officer calls the longest-overdue.

export function runBaseline(a: Assumptions, n: number, seed: number): SimResult {
  const r = rng(seed);
  const world = makePortfolio(n, SIM_START, a, rng(seed));
  const loans = new Map(world.map((w) => [w.loan.id, structuredClone(w.loan)]));
  const lastReminder = new Map<string, string>();
  const lastCall = new Map<string, string>();
  const wallets = new Wallets(world, SIM_START, a);
  const payB = (loan: Loan, cents: number) => {
    wallets.spend(loan.id, cents);
    return applyPayment(loan, cents);
  };
  let outreach = 0;

  for (let d = 0; d < SIM_DAYS; d++) {
    const day = addDays(SIM_START, d);
    wallets.advance(day);
    const late: Array<{ w: SimBorrower; dpd: number }> = [];
    for (const w of world) {
      let loan = loans.get(w.loan.id)!;
      const next = loan.schedule.find((i) => remaining(i) > 0);
      if (!next) continue;
      const until = daysBetween(day, next.dueDate);
      const dpd = daysPastDue(loan, day);
      // 3 days before, on the day, every 3 days for 3 weeks, then weekly.
      const remind = until === 3 || until === 0 || (dpd > 0 && (dpd <= 21 ? dpd % 3 === 0 : dpd % 7 === 0));
      if (remind) {
        outreach++;
        lastReminder.set(loan.id, day);
      }
      const due = dueNow(loan, day);
      if (due > 0) {
        const cap = wallets.get(loan.id);
        const last = lastReminder.get(loan.id);
        const reminded = !!last && daysBetween(last, day) <= 2;
        if (due <= cap && r.chance(paysInFull(w, reminded, dpd))) loan = payB(loan, due);
        else if (remind && cap > 0 && r.chance(a.partialWithoutPlan * fatigue(dpd))) loan = payB(loan, Math.min(due, cap));
        loans.set(loan.id, loan);
      }
      if (dpd >= 14) late.push({ w, dpd });
    }
    late.sort((x, y) => y.dpd - x.dpd);
    let made = 0;
    for (const c of late) {
      if (made >= callsPerDay(a, n)) break;
      const last = lastCall.get(c.w.loan.id);
      if (last && daysBetween(last, day) < 7) continue;
      lastCall.set(c.w.loan.id, day);
      made++;
      const loan = loans.get(c.w.loan.id)!;
      const pay = officerCall(r, wallets.get(loan.id), overdueCents(loan, addDays(day, 1)));
      if (pay > 0) loans.set(loan.id, payB(loan, pay));
    }
  }
  return finish('baseline', [...loans.values()], world, outreach, {});
}

// ---------------------------------------------------------------------------
// Agent: the real CollectionsAgent, with simulated borrowers on the other end.

class SimWeather implements Weather {
  constructor(
    private a: Assumptions,
    private r: Rng,
  ) {}
  async rainfall(region: string, today: string) {
    let ratio = rainfallOn(region, today, SIM_START, this.a);
    if (this.r.chance(this.a.signalNoise)) ratio = ratio < 1 ? 1 : this.a.dryRatio;
    return { region, recentMm: ratio * 100, normalMm: 100, ratio, asOf: today };
  }
}

export async function runAgent(a: Assumptions, n: number, seed: number): Promise<SimResult> {
  const r = rng(seed);
  const world = makePortfolio(n, SIM_START, a, rng(seed));
  const byId = new Map(world.map((w) => [w.borrower.id, w]));
  const store = memoryStore({ copy: false });
  const channel = new OutboxChannel();
  const payments = new FakePayments('sim');
  const clock = fixedClock(`${SIM_START}T07:00:00Z`);
  const ids = sequentialIds('x');
  const agent = new CollectionsAgent({ store, ai: new TemplateAI(), payments, channel, weather: new SimWeather(a, rng(seed + 7)), clock, ids });

  const lender: Lender = { id: 'sim', name: 'Sim Lender', playbook: { ...DEFAULT_PLAYBOOK, autonomy: 'auto' }, receivingAccounts: [], timezoneOffsetHours: 3 };
  await store.lenders.put(lender);
  for (const w of world) {
    await store.borrowers.put(structuredClone(w.borrower));
    await store.loans.put(structuredClone(w.loan));
  }

  let seen = 0;
  const lastCall = new Map<string, string>();
  const lastContact = new Map<string, string>();
  const wallets = new Wallets(world, SIM_START, a);
  const pay = async (loanId: string, cents: number) => {
    if (cents <= 0) return;
    const ref = `${loanId}_${ids()}`;
    await payments.createLink({ amountCents: cents, reference: ref });
    payments.markPaid(ref);
    wallets.spend(loanId, cents);
    await agent.handlePayment('sim', ref);
  };
  const payLink = async (ref: string) => {
    payments.markPaid(ref);
    wallets.spend(ref.split('_')[0]!, payments.amountFor(ref) ?? 0);
    await agent.handlePayment('sim', ref);
  };

  for (let d = 0; d < SIM_DAYS; d++) {
    const day = addDays(SIM_START, d);
    clock.set(`${day}T07:00:00Z`);
    wallets.advance(day);
    await agent.dailyCycle('sim');

    for (let round = 0; round < 3; round++) {
      const fresh = channel.sent.slice(seen);
      seen = channel.sent.length;
      if (!fresh.length) break;
      for (const m of fresh) {
        const w = byId.get(m.borrowerId)!;
        if (/^Thank you\b/.test(m.text) && !/plan|agree/.test(m.text)) continue;
        if (m.text.includes('officer will')) continue;
        lastContact.set(w.loan.id, day);
        const loan = (await store.loans.get(w.loan.id))!;
        const dpd = daysPastDue(loan, day);
        const cap = wallets.get(w.loan.id);
        const due = Math.max(dueNow(loan, day), overdueCents(loan, addDays(day, 1)));
        const link = m.text.match(/sim\/pay\/([A-Za-z0-9_-]+)/)?.[1];

        if (/plan is confirmed/.test(m.text)) {
          const amount = link ? payments.amountFor(link) ?? 0 : 0;
          if (link && amount <= cap && r.chance(w.traits.honesty)) await payLink(link);
          continue;
        }
        if (!r.chance(w.traits.responsiveness * fatigue(dpd))) continue;
        if (w.traits.hardshipAt && day >= w.traits.hardshipAt && daysBetween(w.traits.hardshipAt, day) < 45) {
          await agent.handleReply('sim', w.borrower.id, 'I am sick in hospital and cannot pay now');
          continue;
        }
        if (/When do you expect your harvest/.test(m.text)) {
          if (cap > 0) await agent.handleReply('sim', w.borrower.id, offerText(cap, Math.max(due, upcomingAmount(loan)), day, w, true));
          continue;
        }
        if (/dry season|We can agree this plan/.test(m.text)) {
          const plan = (await store.plans.list('sim')).find((p) => p.loanId === loan.id && p.status === 'offered');
          const first = plan?.instalments[0]?.amountCents ?? due;
          if (first <= cap && r.chance(w.traits.honesty)) await agent.handleReply('sim', w.borrower.id, 'Yes, I agree');
          else if (cap > 0) await agent.handleReply('sim', w.borrower.id, offerText(cap, due, day, w));
          continue;
        }
        if (due <= 0) continue;
        if (due <= cap && r.chance(paysInFull(w, true, dpd))) {
          if (link && (payments.amountFor(link) ?? 0) === due) await payLink(link);
          else await pay(loan.id, due);
        } else if (cap > 0) await agent.handleReply('sim', w.borrower.id, offerText(cap, due, day, w));
        else await agent.handleReply('sim', w.borrower.id, 'I need more time, next week');
      }
    }

    // The manager reviews the approval queue once a day.
    for (const p of (await store.plans.list('sim')).filter((x) => x.status === 'pending_approval')) await agent.approvePlan('sim', p.id);

    // Plan instalments on their dates; otherwise the same unprompted behaviour as the baseline.
    const active = new Map((await store.plans.list('sim')).filter((p) => p.status === 'active').map((p) => [p.loanId, p]));
    for (const w of world) {
      const loan = (await store.loans.get(w.loan.id))!;
      if (loan.status === 'closed') continue;
      const cap = wallets.get(w.loan.id);
      const dpd = daysPastDue(loan, day);
      const plan = active.get(loan.id);
      if (plan) {
        const todays = loan.schedule.find((i) => i.dueDate === day && remaining(i) > 0 && plan.instalments.some((p) => p.dueDate === day));
        if (todays && remaining(todays) <= cap && r.chance(w.traits.honesty)) {
          await pay(loan.id, remaining(todays));
          continue;
        }
      }
      const due = dueNow(loan, day);
      if (due <= 0) continue;
      const last = lastContact.get(loan.id);
      const reminded = !!last && daysBetween(last, day) <= 2;
      if (due <= cap && r.chance(paysInFull(w, reminded, dpd))) await pay(loan.id, due);
      else if (last === day && cap > 0 && r.chance(a.partialWithoutPlan * fatigue(dpd))) await pay(loan.id, Math.min(due, cap));
    }

    // Officer works the handed-over cases, largest overdue first.
    const handed = (await store.loans.list('sim')).filter((l) => l.status === 'handed_over');
    handed.sort((x, y) => overdueCents(y, day) - overdueCents(x, day));
    let made = 0;
    for (const loan of handed) {
      if (made >= callsPerDay(a, n)) break;
      const last = lastCall.get(loan.id);
      if (last && daysBetween(last, day) < 7) continue;
      lastCall.set(loan.id, day);
      made++;
      const w = byId.get(loan.borrowerId)!;
      const amount = officerCall(r, wallets.get(loan.id), overdueCents(loan, addDays(day, 1)));
      await pay(loan.id, amount);
      // Hardship stays with the officer; everything else returns to the agent.
      const inHardship = !!w.traits.hardshipAt && day >= w.traits.hardshipAt && daysBetween(w.traits.hardshipAt, day) < 45;
      const current = (await store.loans.get(loan.id))!;
      if (current.status === 'handed_over') await agent.logOfficerCall('sim', loan.id, amount > 0 ? 'paid part' : 'no payment', inHardship);
    }
  }

  const loans = (await store.loans.list('sim')) as Loan[];
  const allPlans = (await store.plans.list('sim')) as Plan[];
  const agreed = allPlans.filter((p) => ['active', 'kept', 'broken'].includes(p.status));
  const kept = agreed.filter((p) => p.status === 'kept').length;
  const runs = await store.runs.list('sim');
  const handovers = runs.filter((x) => x.steps.some((s) => s.kind === 'tool_call' && s.detail === 'hand_over')).length;
  const outreach = channel.sent.filter((m) => !/^Thank you\b/.test(m.text) || /plan/.test(m.text)).length;
  return finish('agent', loans, world, outreach, {
    handovers,
    plansAgreed: agreed.length,
    plansKept: kept,
    planKeptRate: agreed.length ? round(kept / agreed.length) : null,
  });
}

const upcomingAmount = (loan: Loan) => {
  const next = loan.schedule.find((i) => remaining(i) > 0);
  return next ? remaining(next) : 0;
};

function offerText(capCents: number, due: number, day: string, w: SimBorrower, aboutHarvest = false): string {
  const now = Math.max(100, Math.floor(Math.min(capCents, due) / 100 / 100) * 100);
  const harvestSoon = w.traits.harvestDate && w.traits.harvestDate > day && daysBetween(day, w.traits.harvestDate) <= (aboutHarvest ? 60 : 14);
  const later = harvestSoon ? w.traits.harvestDate! : addDays(day, 10);
  const dom = Number(later.slice(8, 10));
  const suffix = [1, 21, 31].includes(dom) ? 'st' : [2, 22].includes(dom) ? 'nd' : [3, 23].includes(dom) ? 'rd' : 'th';
  return `I can pay ${now} now and the rest on the ${dom}${suffix}`;
}
