/**
 * Shared contracts between the API and the dashboard.
 *
 * Every shape that crosses a boundary (HTTP, Gemini output, Firestore) is a
 * zod schema here, so the same definition validates data on both sides.
 * Money is always an integer number of cents (santim for ETB).
 */
import { z } from 'zod';

export const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
export type IsoDate = z.infer<typeof IsoDate>;

export const Cents = z.number().int().nonnegative();

// ---------------------------------------------------------------------------
// Lender settings

export const Autonomy = z.enum(['approve_all', 'approve_sensitive', 'auto']);
export type Autonomy = z.infer<typeof Autonomy>;

export const Playbook = z.object({
  /** Share of the overdue amount a plan must collect up front (0..1). */
  minFirstPaymentShare: z.number().min(0).max(1),
  /** Longest delay of any due date the agent may agree without a manager. */
  maxExtensionDays: z.number().int().min(0),
  /** Most instalments a plan may split the overdue amount into. */
  maxInstalments: z.number().int().min(1),
  /** Plans the agent may agree per loan before a manager must approve. */
  maxPlansPerLoan: z.number().int().min(0),
  /** Local hours during which the agent may contact borrowers. */
  contactHours: z.object({ start: z.number().int().min(0).max(23), end: z.number().int().min(1).max(24) }),
  /** Most messages the agent may send one borrower per day. */
  dailyContactCap: z.number().int().min(1),
  /** Days before a due date to start reminding. */
  remindDaysBefore: z.number().int().min(0),
  autonomy: Autonomy,
});
export type Playbook = z.infer<typeof Playbook>;

export const DEFAULT_PLAYBOOK: Playbook = {
  minFirstPaymentShare: 0.3,
  maxExtensionDays: 14,
  maxInstalments: 3,
  maxPlansPerLoan: 1,
  contactHours: { start: 8, end: 20 },
  dailyContactCap: 1,
  remindDaysBefore: 3,
  autonomy: 'approve_sensitive',
};

// ---------------------------------------------------------------------------
// Borrowers and loans

export const Sector = z.enum(['farming', 'trade', 'salaried', 'other']);
export type Sector = z.infer<typeof Sector>;

export const IncomePattern = z.enum(['harvest', 'market_days', 'monthly', 'irregular']);
export type IncomePattern = z.infer<typeof IncomePattern>;

export const Channel = z.enum(['telegram', 'email']);
export type Channel = z.infer<typeof Channel>;

export const Borrower = z.object({
  id: z.string(),
  lenderId: z.string(),
  name: z.string(),
  phone: z.string().optional(),
  email: z.string().optional(),
  telegramChatId: z.string().optional(),
  preferredChannel: Channel,
  language: z.enum(['en', 'am']),
  region: z.string(),
  sector: Sector,
  incomePattern: IncomePattern,
  optedOut: z.boolean(),
  /** Running summary the agent keeps so it never repeats itself. */
  caseSummary: z.string(),
});
export type Borrower = z.infer<typeof Borrower>;

export const Instalment = z.object({
  dueDate: IsoDate,
  amountCents: Cents,
  paidCents: Cents,
});
export type Instalment = z.infer<typeof Instalment>;

export const LoanStatus = z.enum(['current', 'late', 'in_plan', 'handed_over', 'closed', 'defaulted']);
export type LoanStatus = z.infer<typeof LoanStatus>;

export const Loan = z.object({
  id: z.string(),
  lenderId: z.string(),
  borrowerId: z.string(),
  principalCents: Cents,
  schedule: z.array(Instalment).min(1),
  status: LoanStatus,
  /** How many times the schedule has been changed; feeds the realism check. */
  rescheduleCount: z.number().int().nonnegative(),
  createdAt: IsoDate,
});
export type Loan = z.infer<typeof Loan>;

// ---------------------------------------------------------------------------
// Payments, plans, messages

export const PaymentSource = z.enum(['link', 'receipt', 'manual']);
export const Payment = z.object({
  id: z.string(),
  lenderId: z.string(),
  loanId: z.string(),
  amountCents: Cents,
  source: PaymentSource,
  /** Gateway reference or receipt transaction number; unique per lender. */
  reference: z.string(),
  status: z.enum(['verified', 'verified_by_receipt', 'rejected']),
  receivedAt: z.string(),
});
export type Payment = z.infer<typeof Payment>;

/**
 * offered: sent to the borrower, waiting for their yes.
 * pending_approval: outside the playbook, waiting for a manager.
 * active: agreed and applied to the loan schedule.
 */
export const PlanStatus = z.enum(['offered', 'pending_approval', 'active', 'kept', 'broken', 'rejected', 'expired']);
export const Plan = z.object({
  id: z.string(),
  lenderId: z.string(),
  loanId: z.string(),
  kind: z.enum(['schedule_change', 'payment_plan']),
  instalments: z.array(z.object({ dueDate: IsoDate, amountCents: Cents })).min(1),
  status: PlanStatus,
  realism: z.object({ ok: z.boolean(), score: z.number(), reasons: z.array(z.string()) }),
  createdAt: z.string(),
});
export type Plan = z.infer<typeof Plan>;

export const Intent = z.enum([
  'paid',
  'will_pay_in_full',
  'partial_offer',
  'needs_more_time',
  'hardship',
  'dispute',
  'question',
  'stop',
  'other',
]);
export type Intent = z.infer<typeof Intent>;

export const Message = z.object({
  id: z.string(),
  lenderId: z.string(),
  borrowerId: z.string(),
  direction: z.enum(['out', 'in']),
  channel: Channel,
  text: z.string(),
  intent: Intent.optional(),
  status: z.enum(['sent', 'pending_approval', 'blocked', 'received']),
  at: z.string(),
});
export type Message = z.infer<typeof Message>;

/** What Gemini must return when it reads a borrower reply. */
export const ReplyReading = z.object({
  intent: Intent,
  /** Amount the borrower offers now, in cents, if any. */
  offerNowCents: Cents.nullable(),
  /** Dates and amounts the borrower proposes for the rest. */
  proposedInstalments: z.array(z.object({ dueDate: IsoDate, amountCents: Cents.nullable() })),
  /** Short neutral summary for the case file. */
  summary: z.string(),
});
export type ReplyReading = z.infer<typeof ReplyReading>;

// ---------------------------------------------------------------------------
// Risk and decisions

export const RiskLevel = z.enum(['low', 'medium', 'high']);
export const RiskAssessment = z.object({
  /** Estimated probability the next instalment is missed (0..1). */
  missProbability: z.number().min(0).max(1),
  level: RiskLevel,
  reasons: z.array(z.string()),
});
export type RiskAssessment = z.infer<typeof RiskAssessment>;

export const ActionKind = z.enum(['wait', 'remind', 'early_checkin', 'offer_schedule_change', 'negotiate', 'hand_over']);
export type ActionKind = z.infer<typeof ActionKind>;

export const RegionSignal = z.object({
  region: z.string(),
  /** Rainfall over the last 30 days, mm. */
  recentMm: z.number().nonnegative(),
  /** Typical rainfall for the same 30 days in previous years, mm. */
  normalMm: z.number().nonnegative(),
  /** recent / normal; below 1 means drier than usual. */
  ratio: z.number().nonnegative(),
  asOf: IsoDate,
});
export type RegionSignal = z.infer<typeof RegionSignal>;

/** One entry in the decision trace. */
export const TraceStep = z.object({
  kind: z.enum(['observe', 'tool_call', 'policy', 'decision', 'error']),
  detail: z.string(),
  data: z.unknown().optional(),
});
export type TraceStep = z.infer<typeof TraceStep>;

export const AgentRun = z.object({
  id: z.string(),
  lenderId: z.string(),
  borrowerId: z.string().nullable(),
  trigger: z.enum(['daily_cycle', 'reply', 'payment', 'receipt', 'manager_request']),
  steps: z.array(TraceStep),
  outcome: z.string(),
  at: z.string(),
});
export type AgentRun = z.infer<typeof AgentRun>;
