import type { Assumptions } from './world.js';

const base: Omit<Assumptions, 'name'> = {
  weatherEffect: 0.8,
  dryRatio: 0.4,
  personaMix: [0.45, 0.25, 0.2, 0.1],
  signalNoise: 0,
  officerCallsPerDay: 8,
  partialWithoutPlan: 0.2,
};

/** The stress test: the same comparison under different assumptions. */
export const SCENARIOS: Assumptions[] = [
  { ...base, name: 'Weather matters' },
  { ...base, name: 'Weather matters a little', weatherEffect: 0.3 },
  { ...base, name: 'Weather does not matter', weatherEffect: 0 },
  { ...base, name: 'Harder borrowers', personaMix: [0.25, 0.25, 0.3, 0.2] },
  { ...base, name: 'Noisy signals', signalNoise: 0.3 },
  // Gives the baseline more credit: borrowers often pay part on their own.
  { ...base, name: 'Borrowers pay part unasked', partialWithoutPlan: 0.5 },
];
