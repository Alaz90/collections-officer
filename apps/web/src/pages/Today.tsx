import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, birr } from '../api';
import { ACTION_LABEL, ErrorNote, RainChip, RiskChip, Strip, StripLegend, useApi } from '../components/ui';
import type { CaseRow, Today as TodayData } from '../types';

function CaseLine({ c, today }: { c: CaseRow; today: string }) {
  const loan = { id: c.loanId, lenderId: '', borrowerId: c.borrowerId, principalCents: 0, status: 'current' as const, rescheduleCount: 0, createdAt: today, schedule: c.schedule };
  return (
    <Link className="row" to={`/cases/${c.borrowerId}`}>
      <div>
        <div className="actions" style={{ alignItems: 'center' }}>
          <span className="who">{c.name}</span>
          <Strip loan={loan} today={today} paidLate={new Set(c.paidLate)} />
          <RiskChip risk={c.risk} />
          {c.rainfall && c.sector === 'farming' && <RainChip signal={c.rainfall} />}
        </div>
        <p className="why">
          {c.risk.reasons.filter((r) => !r.startsWith('rainfall')).join(', ') || 'Watching the weather'}. {c.region}, {c.sector}.
        </p>
        <p className="why">
          <strong style={{ color: 'var(--ink)', fontWeight: 500 }}>{ACTION_LABEL[c.nextAction.action] ?? c.nextAction.action}</strong>: {c.nextAction.reason}
        </p>
      </div>
      <div className="amount">
        {birr(Math.round(c.nextAction.expectedAtRiskCents / 10000) * 10000)}
        <small>at stake of {birr(c.outstandingCents)}</small>
      </div>
    </Link>
  );
}

export function Today({ role }: { role: string }) {
  const { data, error, reload } = useApi<TodayData>('/api/today');
  const [running, setRunning] = useState(false);
  const [ran, setRan] = useState<Record<string, number> | null>(null);
  const [runError, setRunError] = useState<string | null>(null);

  async function runCycle() {
    setRunning(true);
    setRunError(null);
    try {
      const r = await api<{ actions: Record<string, number> }>('/api/cycle/run', { method: 'POST' });
      setRan(r.actions);
      await reload();
    } catch (e) {
      setRunError((e as Error).message);
    } finally {
      setRunning(false);
    }
  }

  if (error) return <ErrorNote error={error} />;
  if (!data) return <p className="muted">Loading today’s cases…</p>;
  const t = data.totals;
  const others = data.cases.filter((c) => !data.callList.some((x) => x.loanId === c.loanId) && !data.rising.some((x) => x.loanId === c.loanId));

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Today</h1>
          <p>The agent runs every morning. These are the people who need you, and the ones it is watching before they fall behind.</p>
        </div>
        {role === 'manager' && (
          <button className="primary" onClick={runCycle} disabled={running}>
            {running ? 'Running…' : 'Run today’s cycle now'}
          </button>
        )}
      </div>
      <ErrorNote error={runError} />
      {ran && (
        <p className="notice ok" style={{ marginBottom: 16 }}>
          Cycle finished: {Object.entries(ran).map(([k, v]) => `${v} ${(ACTION_LABEL[k] ?? k).toLowerCase()}`).join(', ')}. Sensitive messages are waiting in Approvals.
        </p>
      )}

      <div className="figures">
        <div><div className="v">{birr(t.dueThisWeekCents)}</div><div className="k">Due in the next 7 days</div></div>
        <div><div className="v">{birr(t.overdueCents)}</div><div className="k">Overdue now</div></div>
        <div><div className="v">{birr(t.collectedThisWeekCents)}</div><div className="k">Collected in the last 7 days</div></div>
        <div><div className="v">{birr(t.promisedCents)}</div><div className="k">Promised in agreed plans</div></div>
      </div>

      <div className="cols">
        <section className="sheet">
          <div className="section-title">
            <h2>Calls to make</h2>
            <span>Ranked by amount at stake</span>
          </div>
          {data.callList.length ? (
            <div className="rows">{data.callList.map((c) => <CaseLine key={c.loanId} c={c} today={data.today} />)}</div>
          ) : (
            <p className="empty">No one needs a call today. The agent is handling every case.</p>
          )}
        </section>
        <section className="sheet">
          <div className="section-title">
            <h2>Watching before they fall behind</h2>
          </div>
          {data.rising.length ? (
            <div className="rows">{data.rising.map((c) => <CaseLine key={c.loanId} c={c} today={data.today} />)}</div>
          ) : (
            <p className="empty">No rising risk among current loans.</p>
          )}
        </section>
      </div>

      <section className="sheet" style={{ marginTop: 16 }}>
        <div className="section-title">
          <h2>All open loans</h2>
          <span>{data.cases.length} loans</span>
        </div>
        <StripLegend />
        <div className="rows" style={{ marginTop: 8 }}>{others.map((c) => <CaseLine key={c.loanId} c={c} today={data.today} />)}</div>
      </section>
    </>
  );
}
