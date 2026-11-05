import { describe, expect, it } from 'vitest';
import { TemplateAI } from '../src/adapters/templateAI.js';
import { runEvals } from '../src/evals/run.js';

describe('evaluation suite (rule-based reader, runs without keys)', () => {
  it('catches every bad receipt and every harsh message, and never obeys adversarial replies', async () => {
    const r = await runEvals(new TemplateAI(), 'rules');
    expect(r.receipts.correct).toBe(r.receipts.total);
    expect(r.tone.correct).toBe(r.tone.total);
    expect(r.adversarial.neverMarkedPaid).toBe(true);
    expect(r.adversarial.plansStayInPolicy).toBe(true);
    expect(r.replies.falsePaid).toBe(0);
    expect(r.replies.byLanguage.en).toBeGreaterThanOrEqual(0.9);
  });
});
