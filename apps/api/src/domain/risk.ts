import type { Borrower, Loan, RegionSignal, RiskAssessment } from '@co/shared';
import type { RepaymentHistory } from './loanMath.js';
import { daysPastDue } from './loanMath.js';

/**
 * Transparent risk score: a logistic model over a handful of named signals.
 *
 * On day one a lender has no history, so the weights below are hand-set and
 * every score can be explained by its largest contributions. As outcomes come
 * in, `fitWeights` (see riskFit.ts) refits them to the lender's own results.
 */

export interface RiskSignals {
  daysPastDue: number;
  lateShare: number; // share of past instalments paid late (0..1)
  lastWasPartial: boolean;
  brokenPlans: number;
  unansweredMessages: number;
  activePlan: boolean;
  /** Rainfall ratio for farming loans; null when not applicable. */
  rainfallRatio: number | null;
}

export type RiskWeights = Record<keyof RiskSignals | 'bias', number>;

export const DEFAULT_WEIGHTS: RiskWeights = {
  bias: -2.6,
  daysPastDue: 0.09,
  lateShare: 1.6,
  lastWasPartial: 0.9,
  brokenPlans: 0.8,
  unansweredMessages: 0.35,
  activePlan: 0.3,
  // Applied to the rainfall shortfall (1 - ratio), only below normal.
  rainfallRatio: 2.2,
};

export function collectSignals(input: {
  loan: Loan;
  borrower: Borrower;
  history: RepaymentHistory;
  brokenPlans: number;
  activePlan: boolean;
  unansweredMessages: number;
  region: RegionSignal | null;
  today: string;
}): RiskSignals {
  const { loan, borrower, history } = input;
  const pastInstalments = history.paidCount + (history.lastWasPartial ? 1 : 0);
  return {
    daysPastDue: daysPastDue(loan, input.today),
    lateShare: pastInstalments ? history.paidLateCount / pastInstalments : 0,
    lastWasPartial: history.lastWasPartial,
    brokenPlans: input.brokenPlans,
    unansweredMessages: input.unansweredMessages,
    activePlan: input.activePlan,
    // Weather only bears on loans tied to farming.
    rainfallRatio: borrower.sector === 'farming' && input.region ? input.region.ratio : null,
  };
}

function contributions(s: RiskSignals, w: RiskWeights): Array<{ key: keyof RiskSignals; value: number }> {
  const shortfall = s.rainfallRatio === null ? 0 : Math.max(0, 1 - s.rainfallRatio);
  return [
    { key: 'daysPastDue', value: w.daysPastDue * Math.min(s.daysPastDue, 60) },
    { key: 'lateShare', value: w.lateShare * s.lateShare },
    { key: 'lastWasPartial', value: s.lastWasPartial ? w.lastWasPartial : 0 },
    { key: 'brokenPlans', value: w.brokenPlans * Math.min(s.brokenPlans, 3) },
    { key: 'unansweredMessages', value: w.unansweredMessages * Math.min(s.unansweredMessages, 5) },
    { key: 'activePlan', value: s.activePlan ? w.activePlan : 0 },
    { key: 'rainfallRatio', value: w.rainfallRatio * shortfall },
  ];
}

function reasonFor(key: keyof RiskSignals, s: RiskSignals): string {
  switch (key) {
    case 'daysPastDue':
      return `${s.daysPastDue} days past due`;
    case 'lateShare':
      return `${Math.round(s.lateShare * 100)}% of past payments were late`;
    case 'lastWasPartial':
      return 'last payment was partial';
    case 'brokenPlans':
      return `${s.brokenPlans} broken plan${s.brokenPlans === 1 ? '' : 's'}`;
    case 'unansweredMessages':
      return `${s.unansweredMessages} ${s.unansweredMessages === 1 ? 'message' : 'messages'} without a reply`;
    case 'activePlan':
      return 'already on a payment plan';
    case 'rainfallRatio':
      return `rainfall at ${Math.round((s.rainfallRatio ?? 1) * 100)}% of normal in their area`;
  }
}

export function assessRisk(s: RiskSignals, w: RiskWeights = DEFAULT_WEIGHTS): RiskAssessment {
  const parts = contributions(s, w);
  const z = w.bias + parts.reduce((sum, p) => sum + p.value, 0);
  const missProbability = 1 / (1 + Math.exp(-z));
  const reasons = parts
    .filter((p) => p.value > 0.15)
    .sort((a, b) => b.value - a.value)
    .slice(0, 3)
    .map((p) => reasonFor(p.key, s));
  const level = missProbability >= 0.6 ? 'high' : missProbability >= 0.3 ? 'medium' : 'low';
  return {
    missProbability: Math.round(missProbability * 1000) / 1000,
    level,
    reasons: reasons.length ? reasons : ['good repayment record'],
  };
}

/** Feature vector in a fixed order, shared with the weight fitter. */
export const FEATURE_KEYS: Array<keyof RiskSignals> = [
  'daysPastDue',
  'lateShare',
  'lastWasPartial',
  'brokenPlans',
  'unansweredMessages',
  'activePlan',
  'rainfallRatio',
];

export function featureVector(s: RiskSignals): number[] {
  return contributions(s, Object.fromEntries([...FEATURE_KEYS, 'bias'].map((k) => [k, 1])) as RiskWeights).map(
    (p) => p.value,
  );
}

/**
 * Refits the weights by logistic regression on observed outcomes
 * (1 = the instalment was missed). Small, dependency-free gradient descent
 * with L2 regularisation towards the starting weights, so a lender with few
 * outcomes stays close to the hand-set model.
 */
export function fitWeights(
  samples: Array<{ signals: RiskSignals; missed: boolean }>,
  start: RiskWeights = DEFAULT_WEIGHTS,
  opts: { iterations?: number; learningRate?: number; l2?: number } = {},
): RiskWeights {
  const iterations = opts.iterations ?? 400;
  const lr = opts.learningRate ?? 0.1;
  const l2 = opts.l2 ?? 0.05;
  if (samples.length === 0) return start;

  const keys = ['bias', ...FEATURE_KEYS] as const;
  const w = keys.map((k) => start[k]);
  const prior = [...w];
  const rows = samples.map((s) => ({ x: [1, ...featureVector(s.signals)], y: s.missed ? 1 : 0 }));

  for (let it = 0; it < iterations; it++) {
    const grad = new Array<number>(w.length).fill(0);
    for (const r of rows) {
      const z = r.x.reduce((sum, xi, i) => sum + xi * w[i]!, 0);
      const p = 1 / (1 + Math.exp(-z));
      for (let i = 0; i < w.length; i++) grad[i]! += (p - r.y) * r.x[i]!;
    }
    for (let i = 0; i < w.length; i++) {
      const reg = l2 * (w[i]! - prior[i]!);
      w[i] = w[i]! - lr * (grad[i]! / rows.length + reg);
    }
  }
  return Object.fromEntries(keys.map((k, i) => [k, Math.round(w[i]! * 1000) / 1000])) as RiskWeights;
}
