/**
 * Interfaces to everything outside the domain. Each has a real adapter
 * (Firestore, Gemini, Chapa, Telegram, Open-Meteo) and an in-memory one used
 * by tests, the simulator and local development without keys.
 */
import type {
  AgentRun,
  Borrower,
  Loan,
  Message,
  Payment,
  Plan,
  Playbook,
  RegionSignal,
  ReplyReading,
} from '@co/shared';

export interface Lender {
  id: string;
  name: string;
  playbook: Playbook;
  /** Account number(s) borrowers transfer to; used by the receipt check. */
  receivingAccounts: string[];
  timezoneOffsetHours: number;
}

export interface Collection<T extends { id: string }> {
  get(id: string): Promise<T | undefined>;
  put(item: T): Promise<void>;
  list(lenderId: string): Promise<T[]>;
}

export interface Store {
  lenders: Collection<Lender & { lenderId?: never }>;
  borrowers: Collection<Borrower>;
  loans: Collection<Loan>;
  payments: Collection<Payment>;
  plans: Collection<Plan>;
  messages: Collection<Message>;
  runs: Collection<AgentRun>;
  signals: Collection<RegionSignal & { id: string; lenderId: string }>;
}

/** What the writer knows when drafting a message. */
export interface MessageBrief {
  action: 'remind' | 'early_checkin' | 'income_checkin' | 'offer_schedule_change' | 'negotiate' | 'plan_confirmation' | 'counter_offer' | 'thanks' | 'receipt_problem' | 'handover_notice';
  borrowerName: string;
  language: 'en' | 'am';
  lenderName: string;
  amountDue: string;
  dueDate: string;
  paymentLink?: string;
  plan?: Array<{ dueDate: string; amount: string }>;
  reason: string;
  caseSummary: string;
}

export interface ReceiptFields {
  transactionId: string | null;
  amountCents: number | null;
  date: string | null;
  sender: string | null;
  receivingAccount: string | null;
  provider: string | null;
}

export interface AI {
  writeMessage(brief: MessageBrief): Promise<string>;
  readReply(text: string, context: { today: string; amountDue: string; caseSummary: string }): Promise<ReplyReading>;
  readReceipt(image: { mimeType: string; base64: string }): Promise<ReceiptFields>;
}

export interface PaymentLink {
  url: string;
  reference: string;
}

export interface PaymentProvider {
  readonly name: string;
  createLink(input: { amountCents: number; reference: string; borrower: Borrower; description: string }): Promise<PaymentLink>;
  /** Asks the gateway for the final state; never trust a webhook alone. */
  verify(reference: string): Promise<{ paid: boolean; amountCents: number }>;
}

export interface MessageChannel {
  send(borrower: Borrower, text: string): Promise<{ delivered: boolean; error?: string }>;
}

export interface Weather {
  rainfall(region: string, today: string): Promise<RegionSignal | null>;
}

export interface Clock {
  now(): Date;
}

export interface Deps {
  store: Store;
  ai: AI;
  payments: PaymentProvider;
  channel: MessageChannel;
  weather: Weather;
  clock: Clock;
  ids: () => string;
}
