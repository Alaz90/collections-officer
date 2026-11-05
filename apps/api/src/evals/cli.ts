import { writeFileSync } from 'node:fs';
import { GeminiAI } from '../adapters/gemini.js';
import { TemplateAI } from '../adapters/templateAI.js';
import { runEvals, type EvalReport } from './run.js';

/**
 * npm run eval
 * Scores the rule-based reader always, and Gemini when GEMINI_API_KEY is set.
 * Fails (exit 1) if Gemini falls below the thresholds, so a prompt or model
 * change that makes the agent worse fails the build.
 */
const THRESHOLDS = { intentAccuracy: 0.85, amountAccuracy: 0.85, falsePaid: 0 };

const reports: EvalReport[] = [await runEvals(new TemplateAI(), 'rules')];
const key = process.env.GEMINI_API_KEY;
const gemini = key ? new GeminiAI(key, process.env.GEMINI_MODEL ?? 'gemini-3.5-flash-lite') : null;
if (gemini) {
  reports.push(await runEvals(gemini, 'gemini'));
  const h = gemini.health;
  console.log(`gemini calls ok: ${h.calls}, failures: ${h.failures}, quota hits: ${h.quotaHits}, skipped: ${h.skipped}${h.lastError ? `, last error: ${h.lastError}` : ''}`);
}
/** A quota limit says nothing about answer quality: report it, but do not score Gemini on fallback answers. */
const quotaLimited = !!gemini && gemini.health.quotaHits > 0;
if (quotaLimited) console.warn('\nGemini ran out of quota during the run, so its scores below include fallback answers and are not used as a gate.');

for (const r of reports) {
  const p = (x: number) => `${Math.round(x * 100)}%`;
  console.log(`\n${r.reader}`);
  console.log(`  replies: intent ${p(r.replies.intentAccuracy)}, amounts ${p(r.replies.amountAccuracy)}, dates ${p(r.replies.dateRecall)}, false "paid" ${r.replies.falsePaid}`);
  console.log(`  by language: ${Object.entries(r.replies.byLanguage).map(([k, v]) => `${k} ${p(v)}`).join(', ')}`);
  console.log(`  adversarial: never marked paid ${r.adversarial.neverMarkedPaid}, plans stay in policy ${r.adversarial.plansStayInPolicy}`);
  console.log(`  receipt checks ${r.receipts.correct}/${r.receipts.total}, tone checks ${r.tone.correct}/${r.tone.total}`);
  if (r.failures.length) console.log(`  misses: ${r.failures.slice(0, 8).join(' | ')}`);
}
writeFileSync('eval-results.json', JSON.stringify({ generatedAt: new Date().toISOString(), reports }, null, 2));

const gem = reports.find((r) => r.reader === 'gemini');
const rules = reports[0]!;
const hardFail =
  rules.receipts.correct < rules.receipts.total ||
  rules.tone.correct < rules.tone.total ||
  !rules.adversarial.plansStayInPolicy ||
  (gem && !quotaLimited &&
    (gem.replies.intentAccuracy < THRESHOLDS.intentAccuracy ||
      gem.replies.amountAccuracy < THRESHOLDS.amountAccuracy ||
      gem.replies.falsePaid > THRESHOLDS.falsePaid ||
      !gem.adversarial.neverMarkedPaid));
if (hardFail) {
  console.error('\nEvaluation below threshold.');
  process.exit(1);
}
console.log('\nwrote eval-results.json');
