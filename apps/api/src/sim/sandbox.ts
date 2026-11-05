import type { Borrower, Loan, Playbook, RegionSignal, RiskAssessment } from '@co/shared';
import { addDays, daysBetween } from '../domain/dates.js';
import { remaining } from '../domain/loanMath.js';
import type { Lender, Segment } from '../ports.js';
import { runAgent, SIM_START } from './run.js';
import { SCENARIOS } from './scenarios.js';
import { rng, type Assumptions, type Persona, type SimBorrower } from './world.js';

/**
 * Policy sandbox: test a playbook change on a simulated copy of the lender's
 * own loan book before using it. The copy keeps each loan's sector, region
 * and size; hidden behaviour is drawn from each borrower's current risk
 * level, and today's dry regions come from the live rainfall signals.
 */

export interface PolicyProposal {
  name: string;
  segment?: { region?: string; sector?: Borrower['sector'] };
  playbook: Partial<Playbook>;
}

export interface SandboxResult {
  proposal: PolicyProposal;
  borrowers: number;
  current: { collectionRate: number; defaultRate: number; collectedCents: number };
  proposed: { collectionRate: number; defaultRate: number; collectedCents: number };
  /** Proposed minus current, scaled back to the real portfolio size. */
  deltaCollectedCents: number;
  deltaDefaults: number;
  /** In the affected segment only. */
  affectedBorrowers: number;
  assumptions: string[];
}

function personaFor(risk: RiskAssessment, r: ReturnType<typeof rng>): Persona {
  const u = r.next();
  if (risk.level === 'low') return u < 0.7 ? 'reliable' : 'forgetful';
  if (risk.level === 'medium') return u < 0.4 ? 'forgetful' : u < 0.85 ? 'struggling' : 'evasive';
  return u < 0.5 ? 'struggling' : 'evasive';
}

export function copyOfPortfolio(
  cases: Array<{ borrower: Borrower; loan: Loan; risk: RiskAssessment }>,
  copies: number,
  seed: number,
  today: string,
): SimBorrower[] {
  const r = rng(seed);
  const out: SimBorrower[] = [];
  for (let c = 0; c < copies; c++) {
    for (const { borrower, loan, risk } of cases) {
      if (loan.status === 'closed') continue;
      // Keep the real schedule, shifted so that today is the first simulated day:
      // overdue instalments stay overdue, paid ones stay paid.
      const schedule = loan.schedule
        .filter((i) => remaining(i) > 0)
        .map((i) => ({ dueDate: addDays(SIM_START, daysBetween(today, i.dueDate)), amountCents: remaining(i), paidCents: 0 }));
      if (!schedule.length) continue;
      const persona = personaFor(risk, r);
      const id = `${borrower.id}-${c}`;
      out.push({
        borrower: { ...borrower, id, lenderId: 'sim', telegramChatId: id, optedOut: false, caseSummary: '', expectedIncomeDate: undefined },
        loan: {
          id: `${loan.id}-${c}`.replace(/[^A-Za-z0-9-]/g, ''),
          lenderId: 'sim',
          borrowerId: id,
          principalCents: schedule.reduce((t, i) => t + i.amountCents, 0),
          schedule: structuredClone(schedule),
          status: 'current',
          rescheduleCount: 0,
          createdAt: SIM_START,
        },
        traits: {
          persona,
          sector: borrower.sector,
          region: borrower.region,
          responsiveness: persona === 'evasive' ? 0.25 : persona === 'forgetful' ? 0.6 : 0.85,
          honesty: persona === 'evasive' ? 0.5 : persona === 'struggling' ? 0.8 : 0.95,
          harvestDate: borrower.sector === 'farming' ? addDays(SIM_START, r.int(40, 80)) : null,
          partialShare: persona === 'struggling' ? 0.55 + r.next() * 0.35 : 0.6,
          hardshipAt: r.chance(0.03) ? addDays(SIM_START, r.int(20, 120)) : null,
        },
      });
    }
  }
  return out;
}

export async function runSandbox(input: {
  lender: Lender;
  cases: Array<{ borrower: Borrower; loan: Loan; risk: RiskAssessment }>;
  signals: RegionSignal[];
  proposal: PolicyProposal;
  today: string;
  seeds?: number;
}): Promise<SandboxResult> {
  const { lender, cases, proposal } = input;
  // Only the borrowers the policy touches are simulated; the rest of the book is unaffected.
  const inSegment = (c: (typeof cases)[number]) =>
    (!proposal.segment?.region || c.borrower.region === proposal.segment.region) && (!proposal.segment?.sector || c.borrower.sector === proposal.segment.sector);
  const open = cases.filter((c) => c.loan.status !== 'closed' && inSegment(c));
  const copies = Math.max(1, Math.ceil(100 / Math.max(1, open.length)));
  const dryRegions = input.signals.filter((s) => s.ratio < 0.7).map((s) => s.region);
  const a: Assumptions = { ...SCENARIOS[0]!, name: 'sandbox', dryRegions };
  const seeds = input.seeds ?? 2;

  const proposedSegment: Segment = { name: proposal.name, ...proposal.segment, playbook: proposal.playbook };
  const sum = { cur: { c: 0, d: 0, cents: 0, due: 0 }, pro: { c: 0, d: 0, cents: 0, due: 0 } };
  let simBorrowers = 0;
  for (let s = 1; s <= seeds; s++) {
    const world = copyOfPortfolio(open, copies, s, input.today);
    simBorrowers = world.length;
    const opts = { playbook: lender.playbook, segments: lender.segments, days: 120 };
    const cur = await runAgent(a, world.length, s, { ...opts, world: structuredClone(world) });
    const pro = await runAgent(a, world.length, s, { ...opts, segments: [...(lender.segments ?? []), proposedSegment], world: structuredClone(world) });
    sum.cur.c += cur.collectionRate;
    sum.cur.d += cur.defaultRate;
    sum.cur.cents += cur.collectedCents;
    sum.pro.c += pro.collectionRate;
    sum.pro.d += pro.defaultRate;
    sum.pro.cents += pro.collectedCents;
  }
  const scale = open.length / Math.max(1, simBorrowers);
  const avg = (x: { c: number; d: number; cents: number }) => ({
    collectionRate: round(x.c / seeds),
    defaultRate: round(x.d / seeds),
    collectedCents: Math.round((x.cents / seeds) * scale),
  });
  const current = avg(sum.cur);
  const proposed = avg(sum.pro);
  const affected = open.length;
  return {
    proposal,
    borrowers: open.length,
    current,
    proposed,
    deltaCollectedCents: proposed.collectedCents - current.collectedCents,
    deltaDefaults: Math.round((proposed.defaultRate - current.defaultRate) * open.length * 10) / 10,
    affectedBorrowers: affected,
    assumptions: [
      `Simulated ${simBorrowers} borrowers built from the ${open.length} open loans this policy affects, over ${seeds} run${seeds > 1 ? 's' : ''}.`,
      'Borrower behaviour is drawn from each borrower’s current risk level.',
      dryRegions.length ? `Dry spell assumed in: ${dryRegions.join(', ')} (from rainfall signals).` : 'No region is currently in a dry spell.',
    ],
  };
}

const round = (x: number) => Math.round(x * 1000) / 1000;
