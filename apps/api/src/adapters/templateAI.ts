import type { Intent, ReplyReading } from '@co/shared';
import { addDays } from '../domain/dates.js';
import type { AI, MessageBrief, ReceiptFields } from '../ports.js';

/**
 * Deterministic stand-in for Gemini. Used in tests, in the simulator's
 * fast path, as a fallback when the model is unavailable, and as the
 * baseline the evaluation suite compares Gemini against.
 */

export function templateMessage(b: MessageBrief): string {
  const link = b.paymentLink ? ` You can pay here: ${b.paymentLink}` : '';
  const plan = b.plan?.map((p) => `${p.amount} on ${p.dueDate}`).join(', ');
  switch (b.action) {
    case 'remind':
      return `Hi ${b.borrowerName}, a friendly reminder from ${b.lenderName} that ${b.amountDue} is due on ${b.dueDate}.${link}`;
    case 'early_checkin':
      return `Hi ${b.borrowerName}, this is ${b.lenderName}. Your payment of ${b.amountDue} is due on ${b.dueDate}. Is that date still fine for you? If not, reply and we can find a date that works.`;
    case 'income_checkin':
      return `Hi ${b.borrowerName}, this is ${b.lenderName}. We know it has been a dry season in your area. Your payment of ${b.amountDue} is due on ${b.dueDate}. When do you expect your harvest income? If it helps, you can pay part now and the rest after harvest: just reply with what you can pay now and the date.`;
    case 'offer_schedule_change':
      return `Hi ${b.borrowerName}, we know it has been a dry season in your area. Your payment of ${b.amountDue} is due on ${b.dueDate}. If it helps, you can pay part now and the rest later: ${plan}. Reply YES to agree, or tell us what works for you.`;
    case 'negotiate':
      return `Hi ${b.borrowerName}, your payment of ${b.amountDue} to ${b.lenderName} was due on ${b.dueDate}.${link} If you cannot pay all of it now, reply with what you can pay and when, and we will agree a plan.`;
    case 'counter_offer':
      return `Thank you, ${b.borrowerName}. We can agree this plan: ${plan}. Reply YES to confirm.${link}`;
    case 'plan_confirmation':
      return `Thank you, ${b.borrowerName}. Your plan is confirmed: ${plan}.${link}`;
    case 'thanks':
      return `Thank you, ${b.borrowerName}. We received your payment of ${b.amountDue}.`;
    case 'receipt_problem':
      return `Thank you, ${b.borrowerName}. We could not confirm this receipt automatically, so our officer will check it and get back to you.`;
    case 'handover_notice':
      return `Hi ${b.borrowerName}, our officer from ${b.lenderName} will contact you about your loan.`;
  }
}

const WORD_NUMBERS: Record<string, number> = { half: 0.5 };

function parseAmounts(text: string): number[] {
  return [...text.replace(/,/g, '').matchAll(/(\d+(?:\.\d{1,2})?)\s*(k\b)?/gi)]
    .map((m) => Number(m[1]) * (m[2] ? 1000 : 1))
    .filter((n) => n >= 10 && n < 10_000_000)
    .map((n) => Math.round(n * 100));
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function parseDates(text: string, today: string): string[] {
  const dates: string[] = [];
  const lower = text.toLowerCase();
  const todayDay = new Date(`${today}T00:00:00Z`).getUTCDay();
  WEEKDAYS.forEach((d, i) => {
    if (lower.includes(d)) dates.push(addDays(today, ((i - todayDay + 7) % 7) || 7));
  });
  if (/\btomorrow\b/.test(lower)) dates.push(addDays(today, 1));
  if (/\bnext week\b/.test(lower)) dates.push(addDays(today, 7));
  if (/end of (the )?month/.test(lower)) {
    const d = new Date(`${today}T00:00:00Z`);
    dates.push(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10));
  }
  for (const m of lower.matchAll(/\b(?:on )?the (\d{1,2})(?:st|nd|rd|th)\b/g)) {
    const day = Number(m[1]);
    const d = new Date(`${today}T00:00:00Z`);
    let candidate = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), day));
    if (candidate.toISOString().slice(0, 10) <= today) candidate = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, day));
    dates.push(candidate.toISOString().slice(0, 10));
  }
  return [...new Set(dates)].sort();
}

export function ruleBasedReading(text: string, today: string, amountDueCents = 0): ReplyReading {
  const lower = text.toLowerCase();
  const has = (...words: string[]) => words.some((w) => lower.includes(w));
  let intent: Intent = 'other';
  if (/^\s*stop\s*$/i.test(text) || has('stop messaging', 'unsubscribe')) intent = 'stop';
  else if (has('already paid', 'i paid', 'have paid', 'sent the money', 'transferred')) intent = 'paid';
  else if (has('wrong amount', 'not my loan', 'never borrowed', 'dispute', 'mistake')) intent = 'dispute';
  else if (has('hospital', 'sick', 'lost my job', 'died', 'funeral', 'flood', 'fire')) intent = 'hardship';
  else if (has('half', 'part', 'only', 'some now', 'rest')) intent = 'partial_offer';
  else if (has('yes', 'ok', 'okay', 'agree', 'will pay')) intent = 'will_pay_in_full';
  else if (has('more time', 'next week', 'later', 'cannot pay', "can't pay")) intent = 'needs_more_time';
  else if (text.includes('?')) intent = 'question';

  const amounts = parseAmounts(text);
  let offerNowCents: number | null = amounts[0] ?? null;
  if (offerNowCents === null && /\bhalf\b/.test(lower) && amountDueCents > 0) offerNowCents = Math.round(amountDueCents * (WORD_NUMBERS.half ?? 0.5));
  if (intent === 'other' && offerNowCents !== null) intent = 'partial_offer';
  const dates = parseDates(text, today);
  return {
    intent,
    offerNowCents: intent === 'partial_offer' ? offerNowCents : null,
    proposedInstalments: dates.map((dueDate) => ({ dueDate, amountCents: null })),
    summary: text.slice(0, 140),
  };
}

export class TemplateAI implements AI {
  async writeMessage(brief: MessageBrief) {
    return templateMessage(brief);
  }

  async readReply(text: string, context: { today: string; amountDue: string }) {
    const due = Math.round(Number(context.amountDue.replace(/[^\d.]/g, '')) * 100) || 0;
    return ruleBasedReading(text, context.today, due);
  }

  async readReceipt(): Promise<ReceiptFields> {
    return { transactionId: null, amountCents: null, date: null, sender: null, receivingAccount: null, provider: null };
  }
}
