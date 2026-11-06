import { GoogleGenAI, type Content, type FunctionDeclaration } from '@google/genai';
import type { Borrower, Playbook } from '@co/shared';
import { REGION_COORDS } from '../adapters/weather.js';
import { formatBirr } from '../domain/money.js';
import type { Lender, Store } from '../ports.js';
import { runSandbox, type PolicyProposal, type SandboxResult } from '../sim/sandbox.js';
import { portfolioView } from '../views.js';
import type { CollectionsAgent } from './service.js';

/**
 * The manager's agent: takes a problem in plain language, works through it
 * with tools (find loans, test policies in the sandbox, draft a change) and
 * recommends one option. Nothing changes until the manager approves.
 */

export interface ManagerStep {
  tool: string;
  input: unknown;
  summary: string;
}

export interface ManagerAnswer {
  answer: string;
  steps: ManagerStep[];
  draft: PolicyProposal | null;
  tests: SandboxResult[];
}

interface Ctx {
  store: Store;
  agent: CollectionsAgent;
  lenderId: string;
  today: string;
}

const POLICY_PARAMS = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'Short name for the policy' },
    region: { type: 'string', description: 'Limit to borrowers in this region' },
    sector: { type: 'string', enum: ['farming', 'trade', 'salaried', 'other'] },
    maxExtensionDays: { type: 'integer', description: 'Longest extension the agent may agree without approval' },
    minFirstPaymentShare: { type: 'number', description: 'Share of the overdue amount required up front, 0..1' },
    maxInstalments: { type: 'integer' },
    remindDaysBefore: { type: 'integer', description: 'Days before the due date to start reminding' },
  },
  required: ['name'],
};

const TOOLS: FunctionDeclaration[] = [
  { name: 'portfolio_summary', description: 'Portfolio at risk, lateness buckets, riskiest segments with rainfall, and the 30/60/90-day cash forecast.', parametersJsonSchema: { type: 'object', properties: {} } },
  {
    name: 'find_loans',
    description: 'Open loans matching a filter, with risk score, reasons and the agent’s next action.',
    parametersJsonSchema: {
      type: 'object',
      properties: { region: { type: 'string' }, sector: { type: 'string' }, lateOnly: { type: 'boolean' }, riskLevel: { type: 'string', enum: ['low', 'medium', 'high'] } },
    },
  },
  { name: 'test_policy', description: 'Run a playbook change on a simulated copy of the loan book and compare it with the current policy.', parametersJsonSchema: POLICY_PARAMS },
  { name: 'draft_policy_change', description: 'Prepare a playbook change for the manager to approve. Does not apply it.', parametersJsonSchema: POLICY_PARAMS },
];

const SYSTEM = `You advise the manager of a small lender on collections. Use the tools to look at the loan book and to test options before recommending anything.
For a question about a group of borrowers: find the affected loans, test two or three policies with test_policy, compare their effect on money collected and loans going bad, then draft the best one with draft_policy_change.
Be concise: three to five sentences, with the numbers from the tools. Never invent numbers. Say that the manager must approve any change.
All money from the tools is in birr (fields ending in Birr). Write plain sentences: no Markdown, no asterisks. Give loans going bad as percentages.`;


/** The model reads money in birr, never cents: rename every *Cents field to *Birr (whole birr). */
function inBirr(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(inBirr);
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).map(([k, x]) =>
        k.endsWith('Cents') && typeof x === 'number' ? [k.replace(/Cents$/, 'Birr'), Math.round(x / 100)] : [k, inBirr(x)],
      ),
    );
  }
  return v;
}

function toProposal(args: Record<string, unknown>): PolicyProposal {
  const playbook: Partial<Playbook> = {};
  if (typeof args.maxExtensionDays === 'number') playbook.maxExtensionDays = args.maxExtensionDays;
  if (typeof args.minFirstPaymentShare === 'number') playbook.minFirstPaymentShare = args.minFirstPaymentShare;
  if (typeof args.maxInstalments === 'number') playbook.maxInstalments = args.maxInstalments;
  if (typeof args.remindDaysBefore === 'number') playbook.remindDaysBefore = args.remindDaysBefore;
  const segment: PolicyProposal['segment'] = {};
  if (typeof args.region === 'string' && args.region) segment.region = args.region;
  if (typeof args.sector === 'string' && args.sector) segment.sector = args.sector as Borrower['sector'];
  return { name: String(args.name ?? 'Policy'), segment: Object.keys(segment).length ? segment : undefined, playbook };
}

async function lenderOf(ctx: Ctx): Promise<Lender> {
  const l = await ctx.store.lenders.get(ctx.lenderId);
  if (!l) throw new Error('unknown lender');
  return l;
}

/** Tool implementations, shared by the Gemini loop and the fallback planner. */
class Tools {
  steps: ManagerStep[] = [];
  tests: SandboxResult[] = [];
  draft: PolicyProposal | null = null;

  constructor(private ctx: Ctx) {}

  async call(name: string, args: Record<string, unknown>): Promise<unknown> {
    switch (name) {
      case 'portfolio_summary': {
        const p = await portfolioView(this.ctx.store, this.ctx.agent, this.ctx.lenderId, this.ctx.today);
        this.steps.push({ tool: name, input: args, summary: `${p.loans} loans, ${Math.round(p.par30 * 100)}% of the book more than 30 days late` });
        return inBirr({ ...p, segments: p.segments.slice(0, 6) });
      }
      case 'find_loans': {
        const cases = await this.ctx.agent.preview(this.ctx.lenderId);
        const rows = cases
          .filter((c) => !args.region || c.borrower.region === args.region)
          .filter((c) => !args.sector || c.borrower.sector === args.sector)
          .filter((c) => !args.riskLevel || c.risk.level === args.riskLevel)
          .filter((c) => !args.lateOnly || c.loan.status === 'late' || c.loan.status === 'handed_over')
          .map((c) => ({ name: c.borrower.name, region: c.borrower.region, sector: c.borrower.sector, risk: c.risk, nextAction: c.decision.action, status: c.loan.status }));
        this.steps.push({ tool: name, input: args, summary: `${rows.length} matching loans` });
        return inBirr(rows.slice(0, 25));
      }
      case 'test_policy': {
        // Each test is a full simulation; three per question keeps an answer inside a free server's CPU and memory.
        if (this.tests.length >= 3) return { error: 'limit of 3 policy tests per question reached; recommend from the tests already run' };
        const proposal = toProposal(args);
        const result = await this.runTest(proposal);
        this.steps.push({
          tool: name,
          input: args,
          summary: `${proposal.name}: ${result.deltaCollectedCents >= 0 ? '+' : ''}${formatBirr(Math.round(result.deltaCollectedCents / 100) * 100)} collected; loans going bad ${Math.round(result.current.defaultRate * 100)}% → ${Math.round(result.proposed.defaultRate * 100)}%`,
        });
        return {
          name: proposal.name,
          collectionRate: { current: result.current.collectionRate, proposed: result.proposed.collectionRate },
          defaultRate: { current: result.current.defaultRate, proposed: result.proposed.defaultRate },
          extraCollectedBirr: Math.round(result.deltaCollectedCents / 100),
          changeInLoansGoingBad: result.deltaDefaults,
          affectedBorrowers: result.affectedBorrowers,
          assumptions: result.assumptions,
        };
      }
      case 'draft_policy_change': {
        this.draft = toProposal(args);
        this.steps.push({ tool: name, input: args, summary: `drafted "${this.draft.name}" for approval` });
        return { drafted: true, needsManagerApproval: true };
      }
      default:
        return { error: `unknown tool ${name}` };
    }
  }

  private async runTest(proposal: PolicyProposal) {
    const lender = await lenderOf(this.ctx);
    const cases = await this.ctx.agent.preview(this.ctx.lenderId);
    const signals = cases.map((c) => c.region).filter((r): r is NonNullable<typeof r> => !!r);
    const result = await runSandbox({ lender, cases, signals, proposal, today: this.ctx.today, seeds: 2 });
    this.tests.push(result);
    return result;
  }
}

export async function askManagerAgent(ctx: Ctx, question: string, gemini?: { apiKey: string; model: string }): Promise<ManagerAnswer> {
  const tools = new Tools(ctx);
  if (gemini) {
    try {
      const answer = await geminiLoop(gemini, tools, question);
      return { answer, steps: tools.steps, draft: tools.draft, tests: tools.tests };
    } catch {
      // fall through to the deterministic planner
    }
  }
  const answer = await fallbackPlanner(ctx, tools, question);
  return { answer, steps: tools.steps, draft: tools.draft, tests: tools.tests };
}

async function geminiLoop(cfg: { apiKey: string; model: string }, tools: Tools, question: string): Promise<string> {
  const client = new GoogleGenAI({ apiKey: cfg.apiKey });
  const contents: Content[] = [{ role: 'user', parts: [{ text: question }] }];
  for (let turn = 0; turn < 8; turn++) {
    const res = await client.models.generateContent({
      model: cfg.model,
      contents,
      config: { systemInstruction: SYSTEM, tools: [{ functionDeclarations: TOOLS }], temperature: 0.2 },
    });
    const calls = res.functionCalls ?? [];
    const modelContent = res.candidates?.[0]?.content;
    if (!calls.length) return res.text?.trim() || 'I could not find an answer.';
    if (modelContent) contents.push(modelContent);
    const parts = [];
    for (const call of calls) {
      const result = await tools.call(call.name ?? '', (call.args ?? {}) as Record<string, unknown>);
      parts.push({ functionResponse: { name: call.name ?? '', response: { result } } });
    }
    contents.push({ role: 'user', parts });
  }
  return 'I ran out of steps before reaching an answer.';
}

/**
 * Without Gemini, the same tools in a fixed plan: find the group the
 * question is about, test three standard options, recommend the best.
 */
async function fallbackPlanner(ctx: Ctx, tools: Tools, question: string): Promise<string> {
  const q = question.toLowerCase();
  const region = Object.keys(REGION_COORDS).find((r) => q.includes(r.toLowerCase()));
  const sector = /farm|harvest|crop/.test(q) ? 'farming' : /shop|trade|trader/.test(q) ? 'trade' : undefined;

  if (/call|who should/.test(q)) {
    const rows = (await tools.call('find_loans', { lateOnly: true })) as Array<{ name: string; risk: { reasons: string[] } }>;
    return rows.length
      ? `Start with ${rows.slice(0, 3).map((r) => `${r.name} (${r.risk.reasons[0]})`).join(', ')}. The call list on the Today page is ranked by the amount at stake.`
      : 'No one needs a call today.';
  }
  if (!region && !sector) {
    const p = (await tools.call('portfolio_summary', {})) as Awaited<ReturnType<typeof portfolioView>>;
    const f = p.forecast[0]!;
    return `${p.loans} open loans; ${Math.round(p.par30 * 100)}% of the book is more than 30 days late. Expected collections over the next 30 days: ${formatBirr(f.expectedCents)} (between ${formatBirr(f.lowCents)} and ${formatBirr(f.highCents)}). The riskiest group is ${p.segments[0]?.sector ?? '–'} borrowers in ${p.segments[0]?.region ?? '–'}.`;
  }

  const scope = { region, sector };
  await tools.call('find_loans', scope);
  const label = [sector === 'farming' ? 'Farmers' : sector === 'trade' ? 'Traders' : 'Borrowers', region ? `in ${region}` : ''].join(' ').trim();
  const options = [
    { name: `${label}: 30-day extension`, ...scope, maxExtensionDays: 30 },
    { name: `${label}: lower first payment (20%)`, ...scope, minFirstPaymentShare: 0.2 },
    { name: `${label}: remind 7 days ahead`, ...scope, remindDaysBefore: 7 },
  ];
  const results: Array<{ name: string; extraCollectedBirr: number; changeInLoansGoingBad: number; defaultRate: { current: number; proposed: number } }> = [];
  for (const o of options) results.push((await tools.call('test_policy', o)) as (typeof results)[number]);
  const best = [...results].sort((a, b) => b.extraCollectedBirr - b.changeInLoansGoingBad * 500 - (a.extraCollectedBirr - a.changeInLoansGoingBad * 500))[0]!;
  const bestOption = options[results.indexOf(best)]!;
  if (best.extraCollectedBirr <= 0 && best.changeInLoansGoingBad >= 0) {
    return `I tested ${options.length} options for ${label.toLowerCase()}; none improved on the current policy in simulation, so I recommend keeping it and following up individually.`;
  }
  await tools.call('draft_policy_change', bestOption);
  return `I tested ${options.length} options for ${label.toLowerCase()} on a simulated copy of your loan book. The best is "${best.name}": about ${formatBirr(best.extraCollectedBirr * 100)} more collected, with loans going bad at ${Math.round(best.defaultRate.proposed * 100)}% instead of ${Math.round(best.defaultRate.current * 100)}% under today’s policy. I have drafted it for your approval; nothing changes until you approve it.`;
}
