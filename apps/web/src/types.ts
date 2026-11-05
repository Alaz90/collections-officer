import type { AgentRun, Borrower, Loan, Message, Payment, Plan, Playbook, RegionSignal, RiskAssessment } from '@co/shared';

export type { AgentRun, Borrower, Loan, Message, Payment, Plan, Playbook, RegionSignal, RiskAssessment };

export interface Decision {
  action: string;
  reason: string;
  expectedAtRiskCents: number;
}

export interface CaseRow {
  borrowerId: string;
  loanId: string;
  name: string;
  region: string;
  sector: string;
  status: string;
  hold: string | null;
  outstandingCents: number;
  risk: RiskAssessment;
  nextAction: Decision;
  rainfall: RegionSignal | null;
  schedule: Loan['schedule'];
  paidLate: string[];
}

export interface Today {
  today: string;
  totals: { dueThisWeekCents: number; overdueCents: number; collectedThisWeekCents: number; promisedCents: number };
  callList: CaseRow[];
  rising: CaseRow[];
  plannedActions: Record<string, number>;
  cases: CaseRow[];
}

export interface CaseDetail {
  borrower: Borrower;
  loan: Loan;
  risk: RiskAssessment | null;
  nextAction: Decision | null;
  rainfall: RegionSignal | null;
  messages: Message[];
  plans: Plan[];
  payments: Payment[];
  runs: AgentRun[];
  telegramInvite: string;
}

export interface ForecastBucket {
  label: string;
  from: string;
  to: string;
  scheduledCents: number;
  expectedCents: number;
  lowCents: number;
  highCents: number;
}

export interface Portfolio {
  loans: number;
  outstandingCents: number;
  par1: number;
  par30: number;
  buckets: Record<string, number>;
  segments: Array<{ region: string; sector: string; loans: number; outstandingCents: number; overdueCents: number; avgMiss: number; rainfall: number | null; source?: string }>;
  forecast: ForecastBucket[];
}

export interface PolicyProposal {
  name: string;
  segment?: { region?: string; sector?: string };
  playbook: Partial<Playbook>;
}

export interface SandboxResult {
  proposal: PolicyProposal;
  borrowers: number;
  current: { collectionRate: number; defaultRate: number; collectedCents: number };
  proposed: { collectionRate: number; defaultRate: number; collectedCents: number };
  deltaCollectedCents: number;
  deltaDefaults: number;
  affectedBorrowers: number;
  assumptions: string[];
}

export interface WeeklyReport {
  from: string;
  to: string;
  collectedCents: number;
  payments: number;
  plansAgreed: number;
  promiseKeptRate: number | null;
  loansSaved: number;
  handedOver: number;
  messagesSent: number;
  decisionsNeeded: { messages: number; plans: number };
  risingRiskRegions: string[];
}

export interface SimRow {
  scenario: string;
  baseline: { collectionRate: number; defaultRate: number; messagesPer1000Birr: number };
  agent: { collectionRate: number; defaultRate: number; messagesPer1000Birr: number; planKeptRate: number | null };
}
