import type { Borrower, Loan, Sector } from '@co/shared';
import { addDays, daysBetween } from '../domain/dates.js';

/**
 * The simulated world: borrowers with hidden traits the agent never sees,
 * and the rules for how they behave. Every assumption that drives the
 * results is a named parameter here, so the stress test can vary it.
 */

export function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    chance: (p: number) => next() < p,
    int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)]!,
  };
}
export type Rng = ReturnType<typeof rng>;

export type Persona = 'reliable' | 'forgetful' | 'struggling' | 'evasive';

export interface Traits {
  persona: Persona;
  sector: Sector;
  region: string;
  /** Chance of reading and answering a message. */
  responsiveness: number;
  /** Chance of keeping a promise when the money is there. */
  honesty: number;
  /** Harvest date for farming borrowers: income arrives after it. */
  harvestDate: string | null;
  /** Share of the instalment a struggling borrower can usually raise at once. */
  partialShare: number;
  hardshipAt: string | null;
}

export interface Assumptions {
  name: string;
  /** How strongly low rainfall cuts a farming borrower's cash before harvest (0..1). */
  weatherEffect: number;
  /** Rainfall ratio in the dry regions during the dry spell. */
  dryRatio: number;
  /** Persona mix: reliable, forgetful, struggling, evasive. */
  personaMix: [number, number, number, number];
  /** Chance that a signal is misleading (risk looks wrong), 0..1. */
  signalNoise: number;
  /** Regions in a dry spell; defaults to DRY_REGIONS. */
  dryRegions?: string[];
  /** Calls the officer can make per day, per 200 borrowers. */
  officerCallsPerDay: number;
  /** Chance that a borrower who cannot pay everything pays what they can, unprompted, on a given reminder. */
  partialWithoutPlan: number;
}

export const DRY_REGIONS = ['Sidama', 'South Ethiopia'] as const;
const WET_REGIONS = ['Oromia', 'Amhara'] as const;

export interface SimBorrower {
  borrower: Borrower;
  loan: Loan;
  traits: Traits;
}

export function makePortfolio(n: number, start: string, a: Assumptions, r: Rng): SimBorrower[] {
  const out: SimBorrower[] = [];
  const [pr, pf, ps] = a.personaMix;
  for (let i = 0; i < n; i++) {
    const u = r.next();
    const persona: Persona = u < pr ? 'reliable' : u < pr + pf ? 'forgetful' : u < pr + pf + ps ? 'struggling' : 'evasive';
    const sectorRoll = r.next();
    const sector: Sector = sectorRoll < 0.5 ? 'farming' : sectorRoll < 0.85 ? 'trade' : 'salaried';
    const region = sector === 'farming' ? r.pick([...DRY_REGIONS, ...WET_REGIONS]) : r.pick(['Addis Ababa', 'Oromia', 'Amhara']);
    const instalment = r.int(10, 60) * 10_000; // 1,000 – 6,000 birr
    const firstDue = addDays(start, r.int(20, 45));
    const schedule = [0, 1, 2, 3].map((k) => ({ dueDate: addDays(firstDue, 30 * k), amountCents: instalment, paidCents: 0 }));
    const id = `s${i}`;
    out.push({
      borrower: {
        id,
        lenderId: 'sim',
        name: `Borrower ${i}`,
        telegramChatId: id,
        preferredChannel: 'telegram',
        language: 'en',
        region,
        sector,
        incomePattern: sector === 'farming' ? 'harvest' : sector === 'trade' ? 'market_days' : 'monthly',
        optedOut: false,
        caseSummary: '',
      },
      loan: {
        id: `loan${i}`,
        lenderId: 'sim',
        borrowerId: id,
        principalCents: instalment * 4,
        schedule,
        status: 'current',
        rescheduleCount: 0,
        createdAt: start,
      },
      traits: {
        persona,
        sector,
        region,
        responsiveness: persona === 'evasive' ? 0.25 : persona === 'forgetful' ? 0.6 : 0.85,
        honesty: persona === 'evasive' ? 0.5 : persona === 'struggling' ? 0.8 : 0.95,
        harvestDate: sector === 'farming' ? addDays(start, r.int(70, 100)) : null,
        partialShare: persona === 'struggling' ? 0.55 + r.next() * 0.35 : 0.6,
        hardshipAt: r.chance(0.03) ? addDays(start, r.int(20, 120)) : null,
      },
    });
  }
  return out;
}

/** Rainfall ratio for a region on a day: a dry spell in two regions. */
export function rainfallOn(region: string, day: string, start: string, a: Assumptions): number {
  const d = daysBetween(start, day);
  const dry = (a.dryRegions ?? [...DRY_REGIONS] as string[]).includes(region) && d >= 25 && d <= 95;
  return dry ? a.dryRatio : 1;
}

/** Share of unspent cash that goes on other needs each day. */
export const DAILY_LEAK = 0.03;

/**
 * Income towards the loan, per day, as a multiple of one instalment.
 * A borrower whose monthly income is below 1 instalment cannot keep up and
 * falls behind; arrears then compound. Farming borrowers earn less before
 * harvest, and less again in a dry spell, by `weatherEffect`.
 */
export function dailyIncome(t: Traits, day: string, start: string, a: Assumptions): number {
  let monthly = t.persona === 'reliable' ? 1.25 : t.persona === 'forgetful' ? 1.15 : t.persona === 'struggling' ? t.partialShare : 0.85;
  if (t.sector === 'farming' && t.harvestDate && day < t.harvestDate) {
    monthly *= 0.6 * (1 - a.weatherEffect * (1 - rainfallOn(t.region, day, start, a)));
  }
  if (t.hardshipAt && day >= t.hardshipAt && daysBetween(t.hardshipAt, day) < 45) monthly *= 0.2;
  return Math.max(0, monthly) / 30;
}

/** One-off harvest income, as a multiple of one instalment. */
export const HARVEST_LUMP = 2;

/**
 * Cash each borrower has available for the loan. Income accrues daily,
 * harvest adds a lump, and unspent cash leaks away to other needs, so money
 * that is not collected when it is there is gone.
 */
export class Wallets {
  private cash = new Map<string, number>();

  constructor(
    private world: SimBorrower[],
    private start: string,
    private a: Assumptions,
  ) {
    for (const w of world) this.cash.set(w.loan.id, 0.6 * w.loan.schedule[0]!.amountCents);
  }

  advance(day: string) {
    for (const w of this.world) {
      const inst = w.loan.schedule[0]!.amountCents;
      let c = this.cash.get(w.loan.id)! * (1 - DAILY_LEAK) + dailyIncome(w.traits, day, this.start, this.a) * inst;
      if (w.traits.harvestDate === day) c += HARVEST_LUMP * inst * (1 - this.a.weatherEffect * (1 - this.a.dryRatio) * ((this.a.dryRegions ?? [...DRY_REGIONS] as string[]).includes(w.traits.region) ? 0.5 : 0));
      this.cash.set(w.loan.id, c);
    }
  }

  get(loanId: string) {
    return Math.floor(this.cash.get(loanId) ?? 0);
  }

  spend(loanId: string, cents: number) {
    this.cash.set(loanId, Math.max(0, (this.cash.get(loanId) ?? 0) - cents));
  }
}

