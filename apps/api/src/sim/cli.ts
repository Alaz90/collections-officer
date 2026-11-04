import { writeFileSync } from 'node:fs';
import { runAgent, runBaseline, type SimResult } from './run.js';
import { SCENARIOS } from './scenarios.js';

/**
 * npm run simulate -- [borrowers] [seeds]
 * Runs every stress-test scenario for the baseline and the agent, averages
 * over several seeds, prints a table and writes sim-results.json.
 */
const n = Number(process.argv[2] ?? 200);
const seeds = Number(process.argv[3] ?? 3);

function avg(results: SimResult[]) {
  const mean = (f: (r: SimResult) => number) => results.reduce((s, r) => s + f(r), 0) / results.length;
  return {
    collectionRate: mean((r) => r.collectionRate),
    defaultRate: mean((r) => r.defaultRate),
    messagesPer1000Birr: mean((r) => r.messagesPer1000Birr),
    planKeptRate: results[0]!.planKeptRate === null ? null : mean((r) => r.planKeptRate ?? 0),
  };
}

const rows = [];
for (const scenario of SCENARIOS) {
  const base: SimResult[] = [];
  const agent: SimResult[] = [];
  for (let s = 1; s <= seeds; s++) {
    base.push(runBaseline(scenario, n, s));
    agent.push(await runAgent(scenario, n, s));
  }
  const b = avg(base);
  const a = avg(agent);
  rows.push({ scenario: scenario.name, baseline: b, agent: a });
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  console.log(
    `${scenario.name.padEnd(26)} collected ${pct(b.collectionRate)} → ${pct(a.collectionRate)}   defaults ${pct(b.defaultRate)} → ${pct(a.defaultRate)}   msgs/1000 birr ${b.messagesPer1000Birr.toFixed(2)} → ${a.messagesPer1000Birr.toFixed(2)}   plans kept ${a.planKeptRate === null ? '–' : pct(a.planKeptRate)}`,
  );
}
writeFileSync('sim-results.json', JSON.stringify({ borrowers: n, seeds, generatedAt: new Date().toISOString(), rows }, null, 2));
console.log('\nwrote sim-results.json');
