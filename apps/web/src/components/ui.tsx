import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import type { Loan, RegionSignal, RiskAssessment } from '../types';

/** Fetches a path and re-fetches on demand. */
export function useApi<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    if (!path) return;
    setLoading(true);
    try {
      setData(await api<T>(path));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [path]);
  useEffect(() => {
    void load();
  }, [load]);
  return { data, error, loading, reload: load };
}

export function RiskChip({ risk }: { risk: RiskAssessment }) {
  const label = { low: 'Low risk', medium: 'Medium risk', high: 'High risk' }[risk.level];
  return (
    <span className={`chip ${risk.level}`} title={`Estimated chance of missing the next payment: ${Math.round(risk.missProbability * 100)}%`}>
      {label} ({Math.round(risk.missProbability * 100)}%)
    </span>
  );
}

export function RainChip({ signal }: { signal: RegionSignal | null }) {
  if (!signal) return null;
  return (
    <span className={`chip ${signal.ratio < 0.7 ? 'medium' : ''}`}>
      Rainfall {Math.round(signal.ratio * 100)}% of normal
      {signal.source === 'demo' && <em style={{ fontStyle: 'normal', opacity: 0.75 }}>(demo data)</em>}
    </span>
  );
}

type Block = 'paid' | 'late' | 'partial' | 'missed' | 'due';

/** One block per instalment, read from the schedule as it stands today. */
export function blocks(loan: Loan, today: string, paidLate: Set<string> = new Set()): Array<{ kind: Block; date: string; label: string }> {
  return loan.schedule.map((i) => {
    const left = i.amountCents - i.paidCents;
    const past = i.dueDate < today;
    let kind: Block;
    if (left <= 0) kind = paidLate.has(i.dueDate) ? 'late' : 'paid';
    else if (!past) kind = i.paidCents > 0 ? 'partial' : 'due';
    else kind = i.paidCents > 0 ? 'partial' : 'missed';
    const label = { paid: 'Paid on time', late: 'Paid late', partial: 'Partly paid', missed: 'Missed', due: 'Not due yet' }[kind];
    return { kind, date: i.dueDate, label };
  });
}

export function Strip({ loan, today, big, paidLate }: { loan: Loan; today: string; big?: boolean; paidLate?: Set<string> }) {
  const items = blocks(loan, today, paidLate);
  return (
    <span className={`strip ${big ? 'big' : ''}`} role="img" aria-label={items.map((b) => `${b.date}: ${b.label}`).join(', ')}>
      {items.map((b) => (
        <i key={b.date} className={b.kind} title={`${b.date}: ${b.label}`} />
      ))}
    </span>
  );
}

export function StripLegend() {
  return (
    <div className="legend">
      <span><Strip loan={fake('paid')} today="2000-01-02" /> Paid on time</span>
      <span><Strip loan={fake('paid')} today="2000-01-02" paidLate={new Set(['2000-01-01'])} /> Paid late</span>
      <span><Strip loan={fake('partial')} today="2000-01-02" /> Partly paid</span>
      <span><Strip loan={fake('missed')} today="2000-01-02" /> Missed</span>
      <span><Strip loan={fake('due')} today="1999-12-01" /> Not due yet</span>
    </div>
  );
}

function fake(kind: Block): Loan {
  const paid = kind === 'paid' ? 100 : kind === 'partial' ? 50 : 0;
  return {
    id: kind, lenderId: '', borrowerId: '', principalCents: 100, status: 'current', rescheduleCount: 0, createdAt: '2000-01-01',
    schedule: [{ dueDate: '2000-01-01', amountCents: 100, paidCents: paid }],
  };
}

/** Instalments that were completed after their due date, replaying payments oldest first. */
export function paidLateDates(loan: Loan, payments: Array<{ amountCents: number; receivedAt: string; status: string }>): Set<string> {
  const due = loan.schedule.map((i) => ({ date: i.dueDate, amount: i.amountCents, paid: 0 }));
  const late = new Set<string>();
  for (const p of [...payments].filter((x) => x.status !== 'rejected').sort((a, b) => a.receivedAt.localeCompare(b.receivedAt))) {
    let left = p.amountCents;
    for (const d of due) {
      if (left <= 0) break;
      const take = Math.min(left, d.amount - d.paid);
      if (take <= 0) continue;
      d.paid += take;
      left -= take;
      if (d.paid >= d.amount && p.receivedAt.slice(0, 10) > d.date) late.add(d.date);
    }
  }
  return late;
}

export function ErrorNote({ error }: { error: string | null }) {
  return error ? <p className="notice err">{error}</p> : null;
}

export const ACTION_LABEL: Record<string, string> = {
  wait: 'No action needed',
  remind: 'Send a reminder',
  early_checkin: 'Check in before the due date',
  offer_schedule_change: 'Offer a schedule that fits their income',
  negotiate: 'Agree a payment plan',
  hand_over: 'Needs a call from you',
};
