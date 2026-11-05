import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, birr, shortDate } from '../api';
import { ErrorNote, useApi } from '../components/ui';
import type { Message, Plan } from '../types';

type Pending = {
  messages: Array<Message & { borrowerName?: string }>;
  plans: Array<Plan & { borrowerId?: string; borrowerName?: string }>;
};

function MessageItem({ m, onDone }: { m: Pending['messages'][number]; onDone: () => void }) {
  const [text, setText] = useState(m.text);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function act(kind: 'approve' | 'reject') {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/messages/${m.id}/${kind}`, { method: 'POST', body: kind === 'approve' && text !== m.text ? { text } : {} });
      onDone();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <div className="row" style={{ gridTemplateColumns: '1fr' }}>
      <div className="actions" style={{ justifyContent: 'space-between' }}>
        <Link className="who" to={`/cases/${m.borrowerId}`}>{m.borrowerName}</Link>
        <span className="muted small">Drafted {shortDate(m.at)}</span>
      </div>
      <textarea value={text} onChange={(e) => setText(e.target.value)} aria-label={`Message to ${m.borrowerName}`} />
      <ErrorNote error={error} />
      <div className="actions">
        <button className="primary" disabled={busy} onClick={() => act('approve')}>{text !== m.text ? 'Send edited message' : 'Send message'}</button>
        <button className="danger" disabled={busy} onClick={() => act('reject')}>Don’t send</button>
      </div>
    </div>
  );
}

function PlanItem({ p, onDone, canApprove }: { p: Pending['plans'][number]; onDone: () => void; canApprove: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function act(kind: 'approve' | 'reject') {
    setBusy(true);
    try {
      await api(`/api/plans/${p.id}/${kind}`, { method: 'POST' });
      onDone();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <div className="row" style={{ gridTemplateColumns: '1fr' }}>
      <div className="actions" style={{ justifyContent: 'space-between' }}>
        <Link className="who" to={`/cases/${p.borrowerId}`}>{p.borrowerName}</Link>
        <span className={`chip ${p.realism.ok ? 'low' : 'high'}`}>Realism check {p.realism.ok ? 'passed' : 'failed'} ({Math.round(p.realism.score * 100)}%)</span>
      </div>
      <table>
        <tbody>
          {p.instalments.map((i) => (
            <tr key={i.dueDate}><td>{shortDate(i.dueDate)}</td><td className="num">{birr(i.amountCents)}</td></tr>
          ))}
        </tbody>
      </table>
      <p className="why">Outside the playbook, so a manager decides. {p.realism.reasons.join('; ')}.</p>
      <ErrorNote error={error} />
      {canApprove ? (
        <div className="actions">
          <button className="primary" disabled={busy} onClick={() => act('approve')}>Approve and offer to borrower</button>
          <button className="danger" disabled={busy} onClick={() => act('reject')}>Reject plan</button>
        </div>
      ) : (
        <p className="muted small">Waiting for a manager.</p>
      )}
    </div>
  );
}

export function Approvals({ role }: { role: string }) {
  const { data, error, reload } = useApi<Pending>('/api/approvals');
  if (error) return <ErrorNote error={error} />;
  if (!data) return <p className="muted">Loading…</p>;
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Approvals</h1>
          <p>The agent holds sensitive messages and plans outside the playbook here. Edit anything before it goes out; nothing is sent until you approve it.</p>
        </div>
      </div>
      <div className="cols-2">
        <section className="sheet">
          <div className="section-title"><h2>Messages to approve</h2><span>{data.messages.length}</span></div>
          {data.messages.length ? data.messages.map((m) => <MessageItem key={m.id} m={m} onDone={reload} />) : <p className="empty">Nothing waiting. Messages appear here after the morning cycle.</p>}
        </section>
        <section className="sheet">
          <div className="section-title"><h2>Plans to approve</h2><span>{data.plans.length}</span></div>
          {data.plans.length ? data.plans.map((p) => <PlanItem key={p.id} p={p} onDone={reload} canApprove={role === 'manager'} />) : <p className="empty">No plans need a manager.</p>}
        </section>
      </div>
    </>
  );
}
