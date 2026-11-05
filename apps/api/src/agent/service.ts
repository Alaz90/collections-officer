import type { AgentRun, Borrower, Loan, Message, Plan, RegionSignal, RiskAssessment, TraceStep } from '@co/shared';
import { decide, type Decision } from '../domain/decide.js';
import { daysBetween, toIsoDate } from '../domain/dates.js';
import { applyPayment, daysPastDue, nextUnpaid, overdueCents, remaining, repaymentHistory } from '../domain/loanMath.js';
import { formatBirr } from '../domain/money.js';
import { buildPlan, earlyScheduleChange } from '../domain/negotiation.js';
import { applyPlanToLoan, evaluatePlan } from '../domain/plans.js';
import { checkContact, checkPlan, checkTone, planTarget, type ProposedInstalment } from '../domain/policy.js';
import { checkRealism } from '../domain/realism.js';
import { assessRisk, collectSignals, DEFAULT_WEIGHTS, type RiskWeights } from '../domain/risk.js';
import { playbookFor, type Deps, type Lender, type MessageBrief, type ReceiptFields } from '../ports.js';

/**
 * The agent. Each entry point (daily cycle, reply, payment, receipt) runs one
 * traced decision: observe, decide, check against policy, act, record.
 */

export interface CaseView {
  borrower: Borrower;
  loan: Loan;
  risk: RiskAssessment;
  decision: Decision;
  region: RegionSignal | null;
}

const SENSITIVE: ReadonlySet<MessageBrief['action']> = new Set(['offer_schedule_change', 'counter_offer', 'negotiate']);

class Trace {
  steps: TraceStep[] = [];
  observe(detail: string, data?: unknown) {
    this.steps.push({ kind: 'observe', detail, data });
  }
  tool(detail: string, data?: unknown) {
    this.steps.push({ kind: 'tool_call', detail, data });
  }
  policy(detail: string, data?: unknown) {
    this.steps.push({ kind: 'policy', detail, data });
  }
  decision(detail: string, data?: unknown) {
    this.steps.push({ kind: 'decision', detail, data });
  }
  error(detail: string, data?: unknown) {
    this.steps.push({ kind: 'error', detail, data });
  }
}

export class CollectionsAgent {
  weights: RiskWeights = DEFAULT_WEIGHTS;

  constructor(private deps: Deps) {}

  private today() {
    return toIsoDate(this.deps.clock.now());
  }

  private async lender(lenderId: string): Promise<Lender> {
    const l = await this.deps.store.lenders.get(lenderId);
    if (!l) throw new Error(`unknown lender ${lenderId}`);
    return l;
  }

  private async playbookForLoan(lender: Lender, loan: Loan) {
    const borrower = await this.deps.store.borrowers.get(loan.borrowerId);
    return borrower ? playbookFor(lender, borrower) : lender.playbook;
  }

  private localHour(lender: Lender) {
    return (this.deps.clock.now().getUTCHours() + lender.timezoneOffsetHours + 24) % 24;
  }

  private async record(run: Omit<AgentRun, 'id' | 'at'>) {
    const full: AgentRun = { ...run, id: this.deps.ids(), at: this.deps.clock.now().toISOString() };
    await this.deps.store.runs.put(full);
    return full;
  }

  // -------------------------------------------------------------------------
  // Assessment

  async assess(lenderId: string, loan: Loan, borrower: Borrower): Promise<Omit<CaseView, 'decision'> & { context: Awaited<ReturnType<CollectionsAgent['context']>> }> {
    const today = this.today();
    const context = await this.context(lenderId, loan, borrower);
    const region = borrower.sector === 'farming' ? await this.deps.weather.rainfall(borrower.region, today) : null;
    const signals = collectSignals({
      loan,
      borrower,
      history: context.history,
      brokenPlans: context.brokenPlans,
      activePlan: context.activePlan !== undefined,
      unansweredMessages: context.unanswered,
      region,
      today,
    });
    return { borrower, loan, risk: assessRisk(signals, this.weights), region, context };
  }

  private async context(lenderId: string, loan: Loan, borrower: Borrower) {
    const today = this.today();
    const [payments, plans, messages] = await Promise.all([
      this.deps.store.payments.list(lenderId),
      this.deps.store.plans.list(lenderId),
      this.deps.store.messages.list(lenderId),
    ]);
    const loanPlans = plans.filter((p) => p.loanId === loan.id);
    const mine = messages.filter((m) => m.borrowerId === borrower.id).sort((a, b) => a.at.localeCompare(b.at));
    let unanswered = 0;
    for (const m of mine) {
      if (m.direction === 'in') unanswered = 0;
      else if (m.status === 'sent') unanswered++;
    }
    const next = nextUnpaid(loan);
    const lastOut = [...mine].reverse().find((m) => m.direction === 'out' && m.status !== 'blocked');
    const contactedForCurrentInstalment =
      !!lastOut && !!next && daysBetween(lastOut.at.slice(0, 10), next.dueDate) <= 14 && lastOut.at.slice(0, 10) <= today;
    const sentToday = mine.filter((m) => m.direction === 'out' && m.status === 'sent' && m.at.startsWith(today)).length;
    const lastSent = [...mine].reverse().find((m) => m.direction === 'out' && m.status === 'sent');
    return {
      daysSinceLastContact: lastSent ? daysBetween(lastSent.at.slice(0, 10), today) : null,
      history: repaymentHistory(loan, payments, today),
      plans: loanPlans,
      brokenPlans: loanPlans.filter((p) => p.status === 'broken').length,
      activePlan: loanPlans.find((p) => p.status === 'active'),
      offeredPlan: loanPlans.find((p) => p.status === 'offered'),
      unanswered,
      contactedForCurrentInstalment,
      sentToday,
      messages: mine,
    };
  }

  // -------------------------------------------------------------------------
  // Daily cycle

  /** Risk and the action the agent would take today, for every open loan, without acting. */
  async preview(lenderId: string): Promise<CaseView[]> {
    const lender = await this.lender(lenderId);
    const today = this.today();
    const [loans, borrowers] = await Promise.all([this.deps.store.loans.list(lenderId), this.deps.store.borrowers.list(lenderId)]);
    const byId = new Map(borrowers.map((b) => [b.id, b]));
    const out: CaseView[] = [];
    for (const loan of loans) {
      const borrower = byId.get(loan.borrowerId);
      if (!borrower || loan.status === 'closed' || loan.status === 'defaulted') continue;
      const a = await this.assess(lenderId, loan, borrower);
      const decision = decide({
        loan,
        borrower,
        risk: a.risk,
        playbook: playbookFor(lender, borrower),
        brokenPlans: a.context.brokenPlans,
        activePlan: a.context.activePlan !== undefined,
        unansweredMessages: a.context.unanswered,
        rainfallRatio: a.region && borrower.sector === 'farming' ? a.region.ratio : null,
        contactedForCurrentInstalment: a.context.contactedForCurrentInstalment,
        daysSinceLastContact: a.context.daysSinceLastContact,
        today,
      });
      out.push({ borrower, loan, risk: a.risk, decision, region: a.region });
    }
    return out;
  }

  async dailyCycle(lenderId: string): Promise<{ cases: CaseView[]; actions: Record<string, number> }> {
    const lender = await this.lender(lenderId);
    const today = this.today();
    const [loans, borrowers] = await Promise.all([this.deps.store.loans.list(lenderId), this.deps.store.borrowers.list(lenderId)]);
    const byId = new Map(borrowers.map((b) => [b.id, b]));
    const cases: CaseView[] = [];
    const actions: Record<string, number> = {};

    for (let loan of loans) {
      const borrower = byId.get(loan.borrowerId);
      if (!borrower || loan.status === 'closed' || loan.status === 'defaulted') continue;
      const trace = new Trace();

      // Close out plans whose dates have passed.
      for (const plan of (await this.deps.store.plans.list(lenderId)).filter((p) => p.loanId === loan.id && p.status === 'active')) {
        const status = evaluatePlan(plan, loan, today);
        if (status !== plan.status) {
          await this.deps.store.plans.put({ ...plan, status });
          trace.observe(`plan ${status}`, { planId: plan.id });
          if (status === 'kept') loan = { ...loan, status: 'current' };
          if (status === 'broken') loan = { ...loan, status: 'late' };
          await this.deps.store.loans.put(loan);
        }
      }
      if (loan.status !== 'handed_over' && loan.status !== 'in_plan') {
        const late = daysPastDue(loan, today) > 0;
        if (late !== (loan.status === 'late')) {
          loan = { ...loan, status: late ? 'late' : 'current' };
          await this.deps.store.loans.put(loan);
        }
      }

      const a = await this.assess(lenderId, loan, borrower);
      trace.observe('risk assessed', a.risk);
      if (a.region) trace.observe(`rainfall at ${Math.round(a.region.ratio * 100)}% of normal in ${a.region.region}`, a.region);
      const decision = decide({
        loan,
        borrower,
        risk: a.risk,
        playbook: playbookFor(lender, borrower),
        brokenPlans: a.context.brokenPlans,
        activePlan: a.context.activePlan !== undefined,
        unansweredMessages: a.context.unanswered,
        rainfallRatio: a.region && borrower.sector === 'farming' ? a.region.ratio : null,
        contactedForCurrentInstalment: a.context.contactedForCurrentInstalment,
        daysSinceLastContact: a.context.daysSinceLastContact,
        today,
      });
      trace.decision(`${decision.action}: ${decision.reason}`, decision);
      actions[decision.action] = (actions[decision.action] ?? 0) + 1;

      const outcome = await this.act(lender, loan, borrower, decision, a.context, trace);
      await this.record({ lenderId, borrowerId: borrower.id, trigger: 'daily_cycle', steps: trace.steps, outcome });
      cases.push({ borrower, loan, risk: a.risk, decision, region: a.region });
    }
    return { cases, actions };
  }

  private async act(
    lender: Lender,
    loan: Loan,
    borrower: Borrower,
    decision: Decision,
    ctx: Awaited<ReturnType<CollectionsAgent['context']>>,
    trace: Trace,
  ): Promise<string> {
    const today = this.today();
    const next = nextUnpaid(loan);
    switch (decision.action) {
      case 'wait':
        return 'no action';
      case 'hand_over': {
        const hold = decision.reason.startsWith('plans have not held') ? 'restructuring' : (loan.hold ?? null);
        await this.deps.store.loans.put({ ...loan, status: 'handed_over', hold });
        trace.tool('hand_over', { reason: decision.reason });
        return `handed to officer: ${decision.reason}`;
      }
      case 'remind':
      case 'early_checkin':
      case 'negotiate': {
        const overdue = overdueCents(loan, today);
        const amount = decision.action === 'negotiate' || overdue > 0 ? overdue : next ? remaining(next) : 0;
        const link = decision.action === 'early_checkin' ? undefined : await this.paymentLink(loan, borrower, amount, trace);
        return this.sendMessage(lender, borrower, {
          action: decision.action,
          amountDue: formatBirr(amount),
          dueDate: (decision.action === 'negotiate' ? planTarget(loan, today).dueDate : next?.dueDate) ?? today,
          paymentLink: link,
          reason: decision.reason,
        }, ctx.sentToday, trace);
      }
      case 'offer_schedule_change': {
        // Without a known income date, ask first; the reply becomes the plan.
        if (!borrower.expectedIncomeDate || borrower.expectedIncomeDate <= today) {
          return this.sendMessage(lender, borrower, {
            action: 'income_checkin',
            amountDue: formatBirr(next ? remaining(next) : 0),
            dueDate: next?.dueDate ?? today,
            reason: decision.reason,
          }, ctx.sentToday, trace);
        }
        const instalments = earlyScheduleChange({ loan, playbook: playbookFor(lender, borrower), incomeDate: borrower.expectedIncomeDate, today });
        const plan = await this.proposePlan(lender, loan, 'schedule_change', instalments, ctx, trace);
        if (!plan) return 'schedule change not possible; handed to officer';
        return this.sendMessage(lender, borrower, {
          action: 'offer_schedule_change',
          amountDue: formatBirr(planTarget(loan, today).cents),
          dueDate: next?.dueDate ?? today,
          plan: plan.instalments.map((i) => ({ dueDate: i.dueDate, amount: formatBirr(i.amountCents) })),
          reason: decision.reason,
        }, ctx.sentToday, trace);
      }
    }
  }

  private async paymentLink(loan: Loan, borrower: Borrower, amountCents: number, trace: Trace) {
    if (amountCents <= 0) return undefined;
    const reference = `${loan.id}_${this.deps.ids()}`.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 50);
    try {
      const link = await this.deps.payments.createLink({ amountCents, reference, borrower, description: `Loan ${loan.id}` });
      trace.tool('create_payment_link', { amountCents, reference });
      return link.url;
    } catch (e) {
      trace.error('payment link failed', String(e));
      return undefined;
    }
  }

  /** Builds a plan, checks it with the policy layer and the realism check, and stores it. */
  private async proposePlan(
    lender: Lender,
    loan: Loan,
    kind: Plan['kind'],
    instalments: ProposedInstalment[],
    ctx: Awaited<ReturnType<CollectionsAgent['context']>>,
    trace: Trace,
  ): Promise<Plan | null> {
    const today = this.today();
    const target = planTarget(loan, today).cents;
    const policy = checkPlan({ loan, playbook: await this.playbookForLoan(lender, loan), instalments, targetCents: target, plansSoFar: ctx.plans.filter((p) => p.status !== 'rejected' && p.status !== 'expired' && p.status !== 'offered').length, today });
    trace.policy(`plan ${policy.verdict}`, policy);
    const realism = checkRealism({
      instalments,
      history: ctx.history,
      pastPlans: ctx.plans,
      rescheduleCount: loan.rescheduleCount,
      daysPastDue: daysPastDue(loan, today),
    });
    trace.policy(`realism ${realism.ok ? 'passed' : 'failed'} (${realism.score})`, realism);

    if (policy.verdict === 'deny' || !realism.ok) {
      await this.deps.store.loans.put({ ...loan, status: 'handed_over', hold: !realism.ok ? 'restructuring' : null });
      trace.tool('hand_over', { reason: !realism.ok ? 'restructuring risk' : 'plan not allowed' });
      return null;
    }
    // Supersede any earlier offer for this loan.
    for (const old of ctx.plans.filter((p) => p.status === 'offered')) await this.deps.store.plans.put({ ...old, status: 'expired' });
    const plan: Plan = {
      id: this.deps.ids(),
      lenderId: lender.id,
      loanId: loan.id,
      kind,
      instalments,
      status: policy.verdict === 'needs_approval' ? 'pending_approval' : 'offered',
      realism,
      createdAt: this.deps.clock.now().toISOString(),
    };
    await this.deps.store.plans.put(plan);
    trace.tool('propose_plan', plan);
    return plan;
  }

  private async sendMessage(
    lender: Lender,
    borrower: Borrower,
    brief: Omit<MessageBrief, 'borrowerName' | 'language' | 'lenderName' | 'caseSummary'>,
    sentToday: number,
    trace: Trace,
  ): Promise<string> {
    const nice = (d: string) => (/^\d{4}-\d{2}-\d{2}$/.test(d) ? new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }) : d);
    const full: MessageBrief = {
      ...brief,
      dueDate: nice(brief.dueDate),
      plan: brief.plan?.map((p) => ({ ...p, dueDate: nice(p.dueDate) })),
      borrowerName: borrower.name.split(' ')[0] ?? borrower.name,
      language: borrower.language,
      lenderName: lender.name,
      caseSummary: borrower.caseSummary,
    };
    const text = await this.deps.ai.writeMessage(full);
    trace.tool('write_message', { action: brief.action });
    const tone = checkTone(text);
    const contact = checkContact({ borrower, playbook: playbookFor(lender, borrower), localHour: this.localHour(lender), sentToday });
    trace.policy(`tone ${tone.verdict}, contact ${contact.verdict}`, { tone, contact });

    const needsApproval =
      lender.playbook.autonomy === 'approve_all' || (lender.playbook.autonomy === 'approve_sensitive' && SENSITIVE.has(brief.action));
    let status: Message['status'];
    if (tone.verdict === 'deny') status = 'blocked';
    else if (needsApproval) status = 'pending_approval';
    else if (contact.verdict === 'deny') status = 'blocked';
    else status = (await this.deps.channel.send(borrower, text)).delivered ? 'sent' : 'blocked';

    await this.deps.store.messages.put({
      id: this.deps.ids(),
      lenderId: lender.id,
      borrowerId: borrower.id,
      direction: 'out',
      channel: borrower.preferredChannel,
      text,
      status,
      at: this.deps.clock.now().toISOString(),
    });
    trace.tool('send_message', { status });
    return `${brief.action} message ${status}`;
  }

  // -------------------------------------------------------------------------
  // Events

  async handleReply(lenderId: string, borrowerId: string, text: string): Promise<AgentRun> {
    const lender = await this.lender(lenderId);
    const today = this.today();
    const trace = new Trace();
    const borrower = await this.deps.store.borrowers.get(borrowerId);
    if (!borrower) throw new Error('unknown borrower');
    const loan = (await this.deps.store.loans.list(lenderId)).find((l) => l.borrowerId === borrowerId && l.status !== 'closed');

    await this.deps.store.messages.put({
      id: this.deps.ids(),
      lenderId,
      borrowerId,
      direction: 'in',
      channel: borrower.preferredChannel,
      text,
      status: 'received',
      at: this.deps.clock.now().toISOString(),
    });
    if (!loan) {
      trace.observe('no open loan');
      return this.record({ lenderId, borrowerId, trigger: 'reply', steps: trace.steps, outcome: 'no open loan' });
    }

    const ctx = await this.context(lenderId, loan, borrower);
    const due = planTarget(loan, today);
    const reading = await this.deps.ai.readReply(text, { today, amountDue: formatBirr(due.cents), caseSummary: borrower.caseSummary });
    trace.tool('read_reply', reading);
    const summary = `${borrower.caseSummary}\n${today}: ${reading.summary}`.trim().split('\n').slice(-8).join('\n');
    // Remember when the borrower expects income, for future schedule changes.
    const lastDate = reading.proposedInstalments.map((p) => p.dueDate).sort().at(-1);
    const fresh: Borrower = {
      ...borrower,
      caseSummary: summary,
      optedOut: reading.intent === 'stop' || borrower.optedOut,
      expectedIncomeDate: lastDate && lastDate > today ? lastDate : borrower.expectedIncomeDate,
    };
    await this.deps.store.borrowers.put(fresh);

    let outcome: string;
    switch (reading.intent) {
      case 'stop':
        outcome = 'borrower opted out; officer informed';
        await this.deps.store.loans.put({ ...loan, status: 'handed_over', hold: 'opt_out' });
        break;
      case 'dispute':
      case 'hardship':
        await this.deps.store.loans.put({ ...loan, status: 'handed_over', hold: reading.intent });
        trace.tool('hand_over', { reason: reading.intent });
        outcome = await this.sendMessage(lender, fresh, { action: 'handover_notice', amountDue: formatBirr(due.cents), dueDate: due.dueDate, reason: reading.intent }, 0, trace);
        break;
      case 'paid':
        outcome = 'borrower says paid; waiting for gateway confirmation or a receipt';
        trace.decision(outcome);
        break;
      case 'will_pay_in_full': {
        if (ctx.offeredPlan) {
          outcome = await this.acceptPlan(lender, loan, fresh, ctx.offeredPlan, trace);
        } else {
          const link = await this.paymentLink(loan, fresh, due.cents, trace);
          outcome = await this.sendMessage(lender, fresh, { action: 'remind', amountDue: formatBirr(due.cents), dueDate: due.dueDate, paymentLink: link, reason: 'borrower will pay' }, 0, trace);
        }
        break;
      }
      case 'partial_offer':
      case 'needs_more_time': {
        const built = buildPlan({ loan, playbook: playbookFor(lender, borrower), reading, today });
        trace.decision(`negotiation: ${built.kind}`, built);
        if (built.kind === 'nothing_to_plan') {
          outcome = 'nothing to plan';
          break;
        }
        const kind = overdueCents(loan, today) > 0 ? 'payment_plan' : 'schedule_change';
        const plan = await this.proposePlan(lender, loan, kind, built.instalments, ctx, trace);
        if (!plan) {
          outcome = 'plan refused by policy or realism check; handed to officer';
          await this.sendMessage(lender, fresh, { action: 'handover_notice', amountDue: formatBirr(due.cents), dueDate: due.dueDate, reason: 'plan not possible' }, 0, trace);
          break;
        }
        if (plan.status === 'pending_approval') {
          outcome = 'plan needs a manager; queued for approval';
          break;
        }
        if (built.kind === 'accept') {
          outcome = await this.acceptPlan(lender, loan, fresh, plan, trace);
        } else {
          outcome = await this.sendMessage(lender, fresh, {
            action: 'counter_offer',
            amountDue: formatBirr(due.cents),
            dueDate: due.dueDate,
            plan: plan.instalments.map((i) => ({ dueDate: i.dueDate, amount: formatBirr(i.amountCents) })),
            reason: built.reason,
          }, 0, trace);
        }
        break;
      }
      default:
        await this.deps.store.loans.put({ ...loan, status: 'handed_over' });
        outcome = 'reply needs a person; handed to officer';
    }
    return this.record({ lenderId, borrowerId, trigger: 'reply', steps: trace.steps, outcome });
  }

  private async acceptPlan(lender: Lender, loan: Loan, borrower: Borrower, plan: Plan, trace: Trace) {
    const today = this.today();
    const updated = applyPlanToLoan(loan, plan, today);
    await this.deps.store.loans.put(updated);
    await this.deps.store.plans.put({ ...plan, status: 'active' });
    trace.tool('record_promise', { planId: plan.id, instalments: plan.instalments });
    const first = plan.instalments[0]!;
    const link = await this.paymentLink(updated, borrower, first.amountCents, trace);
    return this.sendMessage(lender, borrower, {
      action: 'plan_confirmation',
      amountDue: formatBirr(first.amountCents),
      dueDate: first.dueDate,
      paymentLink: link,
      plan: plan.instalments.map((i) => ({ dueDate: i.dueDate, amount: formatBirr(i.amountCents) })),
      reason: 'plan agreed',
    }, 0, trace);
  }

  /** Payment webhook: verify with the gateway, record once, update the loan. */
  async handlePayment(lenderId: string, reference: string): Promise<AgentRun> {
    const lender = await this.lender(lenderId);
    const trace = new Trace();
    const existing = (await this.deps.store.payments.list(lenderId)).find((p) => p.reference === reference);
    if (existing) {
      trace.observe('duplicate webhook ignored', { reference });
      return this.record({ lenderId, borrowerId: null, trigger: 'payment', steps: trace.steps, outcome: 'already recorded' });
    }
    const verified = await this.deps.payments.verify(reference);
    trace.tool('verify_payment', verified);
    if (!verified.paid) return this.record({ lenderId, borrowerId: null, trigger: 'payment', steps: trace.steps, outcome: 'not paid' });
    const loanId = reference.split('_')[0]!;
    const loan = await this.deps.store.loans.get(loanId);
    if (!loan) return this.record({ lenderId, borrowerId: null, trigger: 'payment', steps: trace.steps, outcome: 'unknown loan' });
    return this.recordPayment(lender, loan, verified.amountCents, reference, 'link', 'verified', trace, 'payment');
  }

  private async recordPayment(
    lender: Lender,
    loan: Loan,
    amountCents: number,
    reference: string,
    source: 'link' | 'receipt',
    status: 'verified' | 'verified_by_receipt',
    trace: Trace,
    trigger: AgentRun['trigger'],
  ) {
    await this.deps.store.payments.put({
      id: this.deps.ids(),
      lenderId: lender.id,
      loanId: loan.id,
      amountCents,
      source,
      reference,
      status,
      receivedAt: this.deps.clock.now().toISOString(),
    });
    let updated = applyPayment(loan, amountCents);
    if (updated.status !== 'closed' && loan.status === 'late' && daysPastDue(updated, this.today()) === 0) updated = { ...updated, status: 'current' };
    await this.deps.store.loans.put(updated);
    trace.tool('record_payment', { amountCents, reference, status });
    const borrower = await this.deps.store.borrowers.get(loan.borrowerId);
    let outcome = `payment of ${formatBirr(amountCents)} recorded`;
    if (borrower) {
      await this.sendMessage(lender, borrower, { action: 'thanks', amountDue: formatBirr(amountCents), dueDate: this.today(), reason: 'payment received' }, 0, trace);
    }
    return this.record({ lenderId: lender.id, borrowerId: loan.borrowerId, trigger, steps: trace.steps, outcome });
  }

  /** Receipt screenshot: read it, check it, match it or flag it. */
  async handleReceipt(lenderId: string, borrowerId: string, image: { mimeType: string; base64: string }): Promise<AgentRun & { fields: ReceiptFields; problems: string[] }> {
    const lender = await this.lender(lenderId);
    const trace = new Trace();
    const fields = await this.deps.ai.readReceipt(image);
    trace.tool('read_receipt', fields);
    const loan = (await this.deps.store.loans.list(lenderId)).find((l) => l.borrowerId === borrowerId && l.status !== 'closed');
    const problems = await this.receiptProblems(lender, loan, fields);
    trace.policy(problems.length ? `receipt flagged: ${problems.join('; ')}` : 'receipt passed checks', problems);
    const borrower = await this.deps.store.borrowers.get(borrowerId);
    if (problems.length || !loan) {
      if (borrower) {
        await this.sendMessage(lender, borrower, { action: 'receipt_problem', amountDue: '', dueDate: this.today(), reason: problems.join('; ') }, 0, trace);
      }
      const run = await this.record({ lenderId, borrowerId, trigger: 'receipt', steps: trace.steps, outcome: 'receipt sent to officer' });
      return { ...run, fields, problems };
    }
    const run = await this.recordPayment(lender, loan, fields.amountCents!, fields.transactionId!, 'receipt', 'verified_by_receipt', trace, 'receipt');
    return { ...run, fields, problems };
  }

  async receiptProblems(lender: Lender, loan: Loan | undefined, f: ReceiptFields): Promise<string[]> {
    const problems: string[] = [];
    if (!loan) problems.push('no open loan for this borrower');
    if (!f.transactionId) problems.push('no transaction number visible');
    if (!f.amountCents || f.amountCents <= 0) problems.push('no amount visible');
    const normalise = (s: string) => s.replace(/\D/g, '');
    if (!f.receivingAccount || !lender.receivingAccounts.some((a) => normalise(a) === normalise(f.receivingAccount!))) {
      problems.push('paid to an account that is not the lender’s');
    }
    if (f.transactionId) {
      const used = (await this.deps.store.payments.list(lender.id)).some((p) => p.reference === f.transactionId);
      if (used) problems.push('transaction number was already used');
    }
    if (f.date) {
      const age = daysBetween(f.date, this.today());
      if (age < 0) problems.push('receipt is dated in the future');
      else if (age > 30) problems.push('receipt is more than 30 days old');
    }
    if (loan && f.amountCents && f.amountCents > loan.schedule.reduce((s, i) => s + remaining(i), 0)) {
      problems.push('amount is more than the loan balance');
    }
    return problems;
  }

  /**
   * The officer logs a call. Unless they keep the case (hardship, dispute,
   * legal), it returns to the agent's routine follow-up.
   */
  async logOfficerCall(lenderId: string, loanId: string, note: string, keepWithOfficer = false) {
    const loan = await this.deps.store.loans.get(loanId);
    if (!loan) throw new Error('unknown loan');
    const borrower = await this.deps.store.borrowers.get(loan.borrowerId);
    if (borrower) {
      const summary = `${borrower.caseSummary}\n${this.today()}: officer call: ${note}`.trim().split('\n').slice(-8).join('\n');
      await this.deps.store.borrowers.put({ ...borrower, caseSummary: summary });
    }
    if (!keepWithOfficer && loan.status === 'handed_over' && !borrower?.optedOut) {
      const late = daysPastDue(loan, this.today()) > 0;
      await this.deps.store.loans.put({ ...loan, status: late ? 'late' : 'current', hold: null });
    }
    await this.record({
      lenderId,
      borrowerId: loan.borrowerId,
      trigger: 'manager_request',
      steps: [{ kind: 'observe', detail: `officer call logged: ${note}` }],
      outcome: keepWithOfficer ? 'kept with officer' : 'returned to agent',
    });
  }

  // -------------------------------------------------------------------------
  // Human approval

  async approveMessage(lenderId: string, messageId: string, editedText?: string) {
    const lender = await this.lender(lenderId);
    const m = await this.deps.store.messages.get(messageId);
    if (!m || m.status !== 'pending_approval') throw new Error('nothing to approve');
    const borrower = await this.deps.store.borrowers.get(m.borrowerId);
    if (!borrower) throw new Error('unknown borrower');
    const text = editedText ?? m.text;
    if (checkTone(text).verdict === 'deny') throw new Error('message fails the tone check');
    const contact = checkContact({ borrower, playbook: playbookFor(lender, borrower), localHour: this.localHour(lender), sentToday: 0 });
    if (contact.verdict === 'deny') throw new Error(contact.reasons.join('; '));
    const delivered = (await this.deps.channel.send(borrower, text)).delivered;
    await this.deps.store.messages.put({ ...m, text, status: delivered ? 'sent' : 'blocked', at: this.deps.clock.now().toISOString() });
    return delivered;
  }

  async approvePlan(lenderId: string, planId: string) {
    const plan = await this.deps.store.plans.get(planId);
    if (!plan || plan.status !== 'pending_approval') throw new Error('nothing to approve');
    await this.deps.store.plans.put({ ...plan, status: 'offered' });
    const loan = await this.deps.store.loans.get(plan.loanId);
    const borrower = loan && (await this.deps.store.borrowers.get(loan.borrowerId));
    if (!loan || !borrower) return;
    const lender = await this.lender(lenderId);
    const trace = new Trace();
    trace.decision('manager approved plan', { planId });
    await this.sendMessage(lender, borrower, {
      action: 'counter_offer',
      amountDue: formatBirr(plan.instalments.reduce((s, i) => s + i.amountCents, 0)),
      dueDate: plan.instalments[0]!.dueDate,
      plan: plan.instalments.map((i) => ({ dueDate: i.dueDate, amount: formatBirr(i.amountCents) })),
      reason: 'approved by manager',
    }, 0, trace);
    await this.record({ lenderId, borrowerId: borrower.id, trigger: 'manager_request', steps: trace.steps, outcome: 'plan offered after approval' });
  }
}
