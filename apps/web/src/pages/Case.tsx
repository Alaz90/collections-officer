import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, birr, shortDate } from '../api';
import { ACTION_LABEL, ErrorNote, paidLateDates, RainChip, RiskChip, Strip, StripLegend, useApi } from '../components/ui';
import type { AgentRun, CaseDetail } from '../types';

const TRIGGER: Record<string, string> = {
  daily_cycle: 'Morning cycle',
  reply: 'Borrower replied',
  payment: 'Payment received',
  receipt: 'Receipt sent',
  manager_request: 'Staff action',
};
const KIND: Record<string, string> = { observe: 'Saw', tool_call: 'Did', policy: 'Checked', decision: 'Decided', error: 'Problem' };

function Run({ run }: { run: AgentRun }) {
  return (
    <details className="run">
      <summary>
        <span>{TRIGGER[run.trigger] ?? run.trigger}: {run.outcome.replaceAll("_", " ")}</span>
        <span className="muted small">{new Date(run.at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
      </summary>
      <ul className="trace">
        {run.steps.map((s, i) => (
          <li key={i}>
            <span className="k">{KIND[s.kind]}</span>
            <span className={s.kind === 'policy' ? 'policy' : s.kind === 'error' ? 'error' : ''}>{s.detail.replaceAll('_', ' ')}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

export function Case() {
  const { id } = useParams();
  const { data, error, reload } = useApi<CaseDetail>(`/api/cases/${id}`);
  const [reply, setReply] = useState('');
  const [note, setNote] = useState('');
  const [keep, setKeep] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setActionError(null);
    try {
      await fn();
      await reload();
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (error) return <ErrorNote error={error} />;
  if (!data || !data.loan) return <p className="muted">Loading case…</p>;
  const { borrower, loan } = data;
  const today = new Date().toISOString().slice(0, 10);
  const late = paidLateDates(loan, data.payments);
  const owed = loan.schedule.reduce((s, i) => s + i.amountCents - i.paidCents, 0);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{borrower.name}</h1>
          <p>{borrower.region}, {borrower.sector}. Owes {birr(owed)} of {birr(loan.principalCents)}. Loan status: {loan.status.replace('_', ' ')}{loan.hold ? ` (${loan.hold.replace('_', ' ')})` : ''}.</p>
        </div>
        <div className="actions">
          {data.risk && <RiskChip risk={data.risk} />}
          {borrower.sector === 'farming' && <RainChip signal={data.rainfall} />}
        </div>
      </div>

      <section className="sheet">
        <div className="section-title"><h2>Repayment record</h2><span>One block per instalment</span></div>
        <Strip loan={loan} today={today} big paidLate={late} />
        <StripLegend />
        <table style={{ marginTop: 12 }}>
          <thead><tr><th>Due</th><th className="num">Amount</th><th className="num">Paid</th></tr></thead>
          <tbody>
            {loan.schedule.map((i) => (
              <tr key={i.dueDate}><td>{shortDate(i.dueDate)}</td><td className="num">{birr(i.amountCents)}</td><td className="num">{birr(i.paidCents)}</td></tr>
            ))}
          </tbody>
        </table>
        {data.risk && (
          <p className="muted" style={{ marginTop: 12 }}>
            <strong style={{ color: 'var(--ink)' }}>Why this risk:</strong> {data.risk.reasons.join(', ')}.{' '}
            {data.nextAction && <>Next: {ACTION_LABEL[data.nextAction.action] ?? data.nextAction.action} ({data.nextAction.reason}).</>}
          </p>
        )}
      </section>

      <div className="cols" style={{ marginTop: 16 }}>
        <section className="sheet">
          <div className="section-title"><h2>Conversation</h2><span>Telegram</span></div>
          <div className="thread">
            {data.messages.length === 0 && <p className="empty">No messages yet.</p>}
            {data.messages.map((m) => (
              <div key={m.id} className={`bubble ${m.direction} ${m.status}`}>
                {m.text}
                <span className="meta">
                  {new Date(m.at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                  {m.status === 'pending_approval' && ', waiting for approval'}
                  {m.status === 'blocked' && ', not sent'}
                  {m.status === 'superseded' && ', replaced by a newer message'}
                </span>
              </div>
            ))}
          </div>
          <div style={{ marginTop: 16 }}>
            <label htmlFor="reply">Reply as the borrower (for demos without a phone)</label>
            <textarea id="reply" value={reply} onChange={(e) => setReply(e.target.value)} placeholder="I can only pay 1000 now and the rest on the 25th" />
            <div className="actions" style={{ marginTop: 8 }}>
              <button disabled={busy || !reply.trim()} onClick={() => run(async () => { await api('/api/demo/reply', { method: 'POST', body: { borrowerId: borrower.id, text: reply } }); setReply(''); })}>Send reply</button>
              <label className="btn" style={{ margin: 0 }}>
                Send a receipt image
                <input type="file" accept="image/*" hidden onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void run(async () => api('/api/demo/receipt', { method: 'POST', body: { borrowerId: borrower.id, mimeType: f.type, base64: await toBase64(f) } }));
                }} />
              </label>
            </div>
            <p className="muted small" style={{ marginTop: 8 }}>
              Connect a real phone: <a href={data.telegramInvite} target="_blank" rel="noreferrer">Telegram invite link</a>
              {borrower.telegramChatId ? ' (connected)' : ''}
            </p>
          </div>
          <ErrorNote error={actionError} />
        </section>

        <div>
          <section className="sheet">
            <h2 style={{ marginBottom: 12 }}>Log a call</h2>
            <div className="field">
              <label htmlFor="note">What happened</label>
              <textarea id="note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Spoke to him; he will pay 1,000 on Friday." />
            </div>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', color: 'var(--ink)' }}>
              <input type="checkbox" style={{ width: 'auto' }} checked={keep} onChange={(e) => setKeep(e.target.checked)} /> Keep with me (hardship, dispute or legal)
            </label>
            <button className="primary" style={{ marginTop: 8 }} disabled={busy || !note.trim()} onClick={() => run(async () => { await api(`/api/loans/${loan.id}/officer-call`, { method: 'POST', body: { note, keepWithOfficer: keep } }); setNote(''); })}>
              Save call note
            </button>
            <p className="muted small" style={{ marginTop: 8 }}>Unless you keep it, the case goes back to the agent’s routine follow-up.</p>
            {borrower.caseSummary.trim() && (
              <>
                <h3 style={{ marginTop: 16, fontSize: 14 }}>Case notes</h3>
                <ul className="small" style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                  {borrower.caseSummary.trim().split('\n').slice(-6).reverse().map((line, i) => <li key={i}>{line}</li>)}
                </ul>
              </>
            )}
          </section>

          <section className="sheet">
            <h2 style={{ marginBottom: 8 }}>Plans and payments</h2>
            {data.plans.length === 0 && data.payments.length === 0 && <p className="empty">None yet.</p>}
            {data.plans.map((p) => (
              <p key={p.id} className="small" style={{ padding: '4px 0' }}>
                <span className={`chip ${p.status === 'broken' ? 'high' : p.status === 'kept' || p.status === 'active' ? 'low' : ''}`}>{p.status.replace('_', ' ')}</span>{' '}
                {p.kind === 'schedule_change' ? 'Schedule change' : 'Payment plan'}: {p.instalments.map((i) => `${birr(i.amountCents)} on ${shortDate(i.dueDate)}`).join(', ')}
              </p>
            ))}
            {data.payments.map((p) => (
              <p key={p.id} className="small" style={{ padding: '4px 0' }}>
                <span className="chip low">{p.status === 'verified_by_receipt' ? 'verified by receipt' : 'paid'}</span> {birr(p.amountCents)} on {shortDate(p.receivedAt)}
              </p>
            ))}
          </section>

          <section className="sheet">
            <div className="section-title"><h2>What the agent did</h2><span>Every decision, with its checks</span></div>
            {data.runs.length ? data.runs.map((r) => <Run key={r.id} run={r} />) : <p className="empty">No agent activity yet.</p>}
          </section>
        </div>
      </div>
    </>
  );
}
