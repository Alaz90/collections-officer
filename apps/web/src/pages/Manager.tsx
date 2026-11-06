import { useState } from 'react';
import { Bar, BarChart, CartesianGrid, ErrorBar, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api, birr, pct } from '../api';
import { ErrorNote, useApi } from '../components/ui';
import type { Playbook, PolicyProposal, Portfolio as PortfolioData, SandboxResult, SimRow, WeeklyReport } from '../types';

const INK = '#1f5c4a';
const AMBER = '#a86a12';
const GREY = '#b9c4be';

// ---------------------------------------------------------------- Portfolio
export function Portfolio() {
  const { data, error } = useApi<PortfolioData>('/api/portfolio');
  if (error) return <ErrorNote error={error} />;
  if (!data) return <p className="muted">Loading portfolio…</p>;
  const forecast = data.forecast.map((f) => ({
    label: `Next ${f.label}`,
    expected: f.expectedCents / 100,
    scheduled: f.scheduledCents / 100,
    range: [(f.expectedCents - f.lowCents) / 100, (f.highCents - f.expectedCents) / 100],
  }));
  const order = ['current', '1-30', '31-60', '61+'];
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Portfolio</h1>
          <p>Where the book stands, which groups are getting riskier, and the cash to expect.</p>
        </div>
      </div>
      <div className="figures">
        <div><div className="v">{birr(data.outstandingCents)}</div><div className="k">Outstanding on {data.loans} loans</div></div>
        <div><div className="v">{pct(data.par1)}</div><div className="k">Of the book is late</div></div>
        <div><div className="v">{pct(data.par30)}</div><div className="k">Is more than 30 days late</div></div>
        <div><div className="v">{order.map((k) => data.buckets[k] ?? 0).join(' / ')}</div><div className="k">Loans current / 1–30 / 31–60 / 61+ days late</div></div>
      </div>
      <div className="cols-2">
        <section className="sheet">
          <div className="section-title"><h2>Cash forecast</h2><span>Expected, with an 80% range</span></div>
          <div style={{ height: 260 }}>
            <ResponsiveContainer>
              <BarChart data={forecast} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
                <CartesianGrid vertical={false} stroke="#e7ece8" />
                <XAxis dataKey="label" tickLine={false} axisLine={false} />
                <YAxis tickFormatter={(v: number) => `${Math.round(v / 1000)}k`} tickLine={false} axisLine={false} width={40} />
                <Tooltip formatter={(v: number) => `${Math.round(v).toLocaleString('en-US')} birr`} />
                <Legend />
                <Bar dataKey="scheduled" name="Scheduled" fill={GREY} radius={[4, 4, 0, 0]} />
                <Bar dataKey="expected" name="Expected" fill={INK} radius={[4, 4, 0, 0]}>
                  <ErrorBar dataKey="range" width={6} stroke={AMBER} />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          <p className="muted small">Each instalment counts with its likelihood of being paid. The range treats payments as independent, so real swings can be wider.</p>
        </section>
        <section className="sheet">
          <div className="section-title"><h2>Riskiest groups</h2><span>Average chance of missing the next payment</span></div>
          <table>
            <thead><tr><th>Group</th><th className="num">Loans</th><th className="num">Overdue</th><th className="num">Risk</th><th className="num">Rainfall</th></tr></thead>
            <tbody>
              {data.segments.map((s) => (
                <tr key={`${s.region}${s.sector}`}>
                  <td>{s.sector} in {s.region}</td>
                  <td className="num">{s.loans}</td>
                  <td className="num">{birr(s.overdueCents)}</td>
                  <td className="num">{pct(s.avgMiss)}</td>
                  <td className="num">{s.sector === 'farming' && s.rainfall !== null ? `${pct(s.rainfall)}${s.source === 'demo' ? '*' : ''}` : '–'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted small" style={{ marginTop: 8 }}>* Demo rainfall values; other readings are live from Open-Meteo.</p>
        </section>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- Sandbox
const REGIONS = ['', 'Sidama', 'South Ethiopia', 'Oromia', 'Amhara', 'Addis Ababa'];

export function SandboxResultView({ r, onApply }: { r: SandboxResult; onApply?: () => void }) {
  const better = r.deltaCollectedCents > 0 || r.deltaDefaults < 0;
  return (
    <div className={`notice ${better ? 'ok' : ''}`} style={{ marginTop: 12 }}>
      <p><strong>{r.proposal.name}</strong></p>
      <table style={{ margin: '8px 0' }}>
        <thead><tr><th></th><th className="num">Current policy</th><th className="num">With this change</th></tr></thead>
        <tbody>
          <tr><td>Collected</td><td className="num">{pct(r.current.collectionRate)}</td><td className="num">{pct(r.proposed.collectionRate)}</td></tr>
          <tr><td>Loans going bad</td><td className="num">{pct(r.current.defaultRate)}</td><td className="num">{pct(r.proposed.defaultRate)}</td></tr>
          <tr><td>Money collected (your {r.affectedBorrowers} loans)</td><td className="num">{birr(r.current.collectedCents)}</td><td className="num">{birr(r.proposed.collectedCents)}</td></tr>
        </tbody>
      </table>
      {r.deltaCollectedCents === 0 && r.deltaDefaults === 0 && (
        <p className="small">No difference in simulation: for these borrowers the current rule is not what holds repayment back, so this change would not be worth making.</p>
      )}
      <p className="small muted">{r.assumptions.join(' ')}</p>
      {onApply && better && <button className="primary" style={{ marginTop: 8 }} onClick={onApply}>Apply to the playbook</button>}
    </div>
  );
}

export function Sandbox() {
  const [form, setForm] = useState({ name: 'Dry-season extension for farmers', region: 'Sidama', sector: 'farming', maxExtensionDays: '30', minFirstPaymentShare: '', remindDaysBefore: '' });
  const [result, setResult] = useState<SandboxResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState(false);

  const proposal = (): PolicyProposal => {
    const playbook: Partial<Playbook> = {};
    if (form.maxExtensionDays) playbook.maxExtensionDays = Number(form.maxExtensionDays);
    if (form.minFirstPaymentShare) playbook.minFirstPaymentShare = Number(form.minFirstPaymentShare) / 100;
    if (form.remindDaysBefore) playbook.remindDaysBefore = Number(form.remindDaysBefore);
    const segment: PolicyProposal['segment'] = {};
    if (form.region) segment.region = form.region;
    if (form.sector) segment.sector = form.sector;
    return { name: form.name, segment, playbook };
  };
  async function test() {
    setBusy(true);
    setError(null);
    setApplied(false);
    try {
      setResult(await api<SandboxResult>('/api/sandbox', { method: 'POST', body: proposal() }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function apply() {
    await api('/api/policy/apply', { method: 'POST', body: proposal() });
    setApplied(true);
  }
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Policy sandbox</h1>
          <p>Try a change on a simulated copy of your own loan book before using it. Leave a field empty to keep the current setting.</p>
        </div>
      </div>
      <section className="sheet">
        <div className="grid-form">
          <div className="field" style={{ gridColumn: '1 / -1' }}><label htmlFor="pname">Name</label><input id="pname" value={form.name} onChange={set('name')} /></div>
          <div className="field"><label htmlFor="preg">Region</label><select id="preg" value={form.region} onChange={set('region')}>{REGIONS.map((r) => <option key={r} value={r}>{r || 'All regions'}</option>)}</select></div>
          <div className="field"><label htmlFor="psec">Sector</label><select id="psec" value={form.sector} onChange={set('sector')}><option value="">All sectors</option><option value="farming">Farming</option><option value="trade">Trade</option><option value="salaried">Salaried</option></select></div>
          <div className="field"><label htmlFor="pext">Longest extension without approval (days)</label><input id="pext" inputMode="numeric" value={form.maxExtensionDays} onChange={set('maxExtensionDays')} placeholder="14" /></div>
          <div className="field"><label htmlFor="pmin">Minimum first payment (%)</label><input id="pmin" inputMode="numeric" value={form.minFirstPaymentShare} onChange={set('minFirstPaymentShare')} placeholder="30" /></div>
          <div className="field"><label htmlFor="prem">Start reminding (days before due)</label><input id="prem" inputMode="numeric" value={form.remindDaysBefore} onChange={set('remindDaysBefore')} placeholder="3" /></div>
        </div>
        <button className="primary" onClick={test} disabled={busy}>{busy ? 'Simulating… (about 20 seconds)' : 'Test this policy'}</button>
        <ErrorNote error={error} />
        {result && <SandboxResultView r={result} onApply={applied ? undefined : apply} />}
        {applied && <p className="notice ok" style={{ marginTop: 8 }}>Applied. The agent uses it from the next cycle.</p>}
      </section>
    </>
  );
}

// ---------------------------------------------------------------- Ask
type Answer = { answer: string; steps: Array<{ tool: string; summary: string }>; draft: PolicyProposal | null; tests: SandboxResult[] };

export function Ask() {
  const [q, setQ] = useState('Farmers in Sidama are struggling. What should we do?');
  const [a, setA] = useState<Answer | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState(false);
  async function ask() {
    setBusy(true);
    setError(null);
    setApplied(false);
    try {
      setA(await api<Answer>('/api/ask', { method: 'POST', body: { question: q } }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Ask the agent</h1>
          <p>Hand the agent a problem, not just a question. It looks at the loans, tests options in the sandbox and recommends one. Nothing changes until you approve it.</p>
        </div>
      </div>
      <section className="sheet">
        <label htmlFor="q">Your question</label>
        <textarea id="q" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="actions" style={{ marginTop: 8 }}>
          <button className="primary" onClick={ask} disabled={busy || q.trim().length < 3}>{busy ? 'Working through it…' : 'Ask'}</button>
          {['Who should I call first today?', 'How much do we expect to collect this month?'].map((s) => (
            <button key={s} onClick={() => setQ(s)}>{s}</button>
          ))}
        </div>
        <ErrorNote error={error} />
      </section>
      {a && (
        <div className="cols" style={{ marginTop: 16 }}>
          <section className="sheet">
            <h2 style={{ marginBottom: 8 }}>Recommendation</h2>
            <p>{a.answer.split(/\*\*(.+?)\*\*/g).map((part, i) => (i % 2 ? <strong key={i}>{part}</strong> : part))}</p>
            {a.tests.map((t) => <SandboxResultView key={t.proposal.name} r={t} />)}
            {a.draft && !applied && (
              <button className="primary" style={{ marginTop: 12 }} onClick={async () => { await api('/api/policy/apply', { method: 'POST', body: a.draft }); setApplied(true); }}>
                Approve “{a.draft.name}”
              </button>
            )}
            {applied && <p className="notice ok" style={{ marginTop: 12 }}>Approved. The agent uses it from the next cycle.</p>}
          </section>
          <section className="sheet">
            <h2 style={{ marginBottom: 8 }}>How it got there</h2>
            <ol className="steps">
              {a.steps.map((s, i) => (
                <li key={i}><code>{s.tool.replaceAll('_', ' ')}</code><span>{s.summary}</span></li>
              ))}
            </ol>
          </section>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------- Performance
export function Performance() {
  const report = useApi<WeeklyReport>('/api/report/weekly');
  const sim = useApi<{ borrowers: number; seeds: number; rows: SimRow[] } | null>('/api/sim-results');
  const r = report.data;
  const rows = sim.data?.rows ?? [];
  const chart = rows.map((x) => ({ scenario: x.scenario, Reminders: Math.round(x.baseline.defaultRate * 1000) / 10, Agent: Math.round(x.agent.defaultRate * 1000) / 10 }));
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Agent performance</h1>
          <p>The agent reports like an employee: what it did this week, and how it compares with plain reminders in the stress test.</p>
        </div>
      </div>
      <ErrorNote error={report.error} />
      {r && (
        <section className="sheet">
          <div className="section-title"><h2>This week</h2><span>{r.from} to {r.to}</span></div>
          <div className="figures" style={{ marginBottom: 12 }}>
            <div><div className="v">{birr(r.collectedCents)}</div><div className="k">Collected ({r.payments} payments)</div></div>
            <div><div className="v">{r.loansSaved}</div><div className="k">Loans put back on schedule early</div></div>
            <div><div className="v">{r.promiseKeptRate === null ? '–' : pct(r.promiseKeptRate)}</div><div className="k">Plans kept (all finished plans)</div></div>
            <div><div className="v">{r.handedOver}</div><div className="k">Cases handed to an officer</div></div>
          </div>
          <p>
            I sent {r.messagesSent} messages and agreed {r.plansAgreed} plans.{' '}
            {r.risingRiskRegions.length ? `Risk is rising in ${r.risingRiskRegions.join(' and ')} because of low rainfall.` : 'No region shows rising weather risk.'}{' '}
            {r.decisionsNeeded.messages + r.decisionsNeeded.plans > 0
              ? `I need your decision on ${r.decisionsNeeded.messages} messages and ${r.decisionsNeeded.plans} plans in Approvals.`
              : 'Nothing is waiting for your decision.'}
          </p>
        </section>
      )}
      <section className="sheet">
        <div className="section-title"><h2>Stress test: share of loans going bad</h2><span>{sim.data ? `${sim.data.borrowers} simulated borrowers, ${sim.data.seeds} runs per scenario` : ''}</span></div>
        {rows.length ? (
          <>
            <div style={{ height: 280 }}>
              <ResponsiveContainer>
                <BarChart data={chart} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid vertical={false} stroke="#e7ece8" />
                  <XAxis dataKey="scenario" tickLine={false} axisLine={false} interval={0} tick={{ fontSize: 12 }} />
                  <YAxis unit="%" tickLine={false} axisLine={false} width={40} />
                  <Tooltip formatter={(v: number) => `${v}%`} />
                  <Legend />
                  <Bar dataKey="Reminders" name="Plain reminders" fill={GREY} radius={[4, 4, 0, 0]} />
                  <Bar dataKey="Agent" name="Agent" fill={INK} radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
            <table style={{ marginTop: 12 }}>
              <thead><tr><th>Scenario</th><th className="num">Collected: reminders</th><th className="num">Collected: agent</th><th className="num">Plans kept</th><th className="num">Messages per 1,000 birr</th></tr></thead>
              <tbody>
                {rows.map((x) => (
                  <tr key={x.scenario}>
                    <td>{x.scenario}</td>
                    <td className="num">{pct(x.baseline.collectionRate)}</td>
                    <td className="num">{pct(x.agent.collectionRate)}</td>
                    <td className="num">{x.agent.planKeptRate === null ? '–' : pct(x.agent.planKeptRate)}</td>
                    <td className="num">{x.baseline.messagesPer1000Birr.toFixed(1)} → {x.agent.messagesPer1000Birr.toFixed(1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="muted small" style={{ marginTop: 8 }}>Each scenario changes one assumption. Where the agent does not win, the table shows it.</p>
          </>
        ) : (
          <p className="empty">No stress-test results yet. Run <code>npm run simulate</code> to produce them.</p>
        )}
      </section>
    </>
  );
}

// ---------------------------------------------------------------- Setup
type ImportPreview = { headers: string[]; sample: string[][]; mapping: Record<string, string>; mappedBy: string; readable: number; problems: Array<{ row: number; reason: string }> };
const FIELD_LABEL: Record<string, string> = {
  name: 'Borrower name', phone: 'Phone', email: 'Email', region: 'Region', sector: 'Business type', principal: 'Loan amount',
  instalment: 'Instalment amount', firstDueDate: 'First due date', instalments: 'Number of instalments', paid: 'Amount paid so far',
};

export function Setup({ role }: { role: string }) {
  const lender = useApi<{ playbook: Playbook; segments?: Array<{ name: string }> }>('/api/playbook');
  const [pb, setPb] = useState<Playbook | null>(null);
  const [saved, setSaved] = useState(false);
  const [csv, setCsv] = useState('');
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [imported, setImported] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const playbook = pb ?? lender.data?.playbook ?? null;
  const manager = role === 'manager';

  const num = (k: keyof Playbook, scale = 1) => (e: { target: { value: string } }) => playbook && setPb({ ...playbook, [k]: Number(e.target.value) / scale });

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Setup</h1>
          <p>The playbook is the set of limits the agent works within. Code enforces it on every message and plan.</p>
        </div>
      </div>
      <ErrorNote error={lender.error ?? error} />
      <div className="cols-2">
        <section className="sheet">
          <h2 style={{ marginBottom: 12 }}>Playbook</h2>
          {playbook && (
            <>
              <div className="grid-form">
                <div className="field"><label>Minimum first payment (%)</label><input disabled={!manager} type="number" value={Math.round(playbook.minFirstPaymentShare * 100)} onChange={num('minFirstPaymentShare', 100)} /></div>
                <div className="field"><label>Longest extension without approval (days)</label><input disabled={!manager} type="number" value={playbook.maxExtensionDays} onChange={num('maxExtensionDays')} /></div>
                <div className="field"><label>Most instalments in a plan</label><input disabled={!manager} type="number" value={playbook.maxInstalments} onChange={num('maxInstalments')} /></div>
                <div className="field"><label>Plans per loan without approval</label><input disabled={!manager} type="number" value={playbook.maxPlansPerLoan} onChange={num('maxPlansPerLoan')} /></div>
                <div className="field"><label>Messages per borrower per day</label><input disabled={!manager} type="number" value={playbook.dailyContactCap} onChange={num('dailyContactCap')} /></div>
                <div className="field"><label>Start reminding (days before due)</label><input disabled={!manager} type="number" value={playbook.remindDaysBefore} onChange={num('remindDaysBefore')} /></div>
                <div className="field"><label>Contact from (hour)</label><input disabled={!manager} type="number" value={playbook.contactHours.start} onChange={(e) => setPb({ ...playbook, contactHours: { ...playbook.contactHours, start: Number(e.target.value) } })} /></div>
                <div className="field"><label>Contact until (hour)</label><input disabled={!manager} type="number" value={playbook.contactHours.end} onChange={(e) => setPb({ ...playbook, contactHours: { ...playbook.contactHours, end: Number(e.target.value) } })} /></div>
              </div>
              <div className="field">
                <label htmlFor="aut">How much the agent does on its own</label>
                <select id="aut" disabled={!manager} value={playbook.autonomy} onChange={(e) => setPb({ ...playbook, autonomy: e.target.value as Playbook['autonomy'] })}>
                  <option value="approve_all">Ask before every message</option>
                  <option value="approve_sensitive">Ask before plans and late-payment messages</option>
                  <option value="auto">Act on its own within the playbook</option>
                </select>
              </div>
              {manager && (
                <button className="primary" onClick={async () => { await api('/api/playbook', { method: 'PUT', body: { playbook } }); setSaved(true); }}>Save playbook</button>
              )}
              {saved && <p className="notice ok" style={{ marginTop: 8 }}>Saved. The agent uses it from the next cycle.</p>}
              {!!lender.data?.segments?.length && (
                <p className="muted small" style={{ marginTop: 12 }}>Group policies in use: {lender.data.segments.map((s) => s.name).join('; ')}.</p>
              )}
            </>
          )}
        </section>
        <section className="sheet">
          <h2 style={{ marginBottom: 4 }}>Import a loan book</h2>
          <p className="muted small" style={{ marginBottom: 12 }}>Paste your spreadsheet as CSV (File → Download → CSV). Column names do not need to match: the agent works out which column is which, and you confirm.</p>
          <textarea value={csv} onChange={(e) => setCsv(e.target.value)} placeholder={'Client,Phone,Kebele,Business,Loan amount,Monthly,First due,Months\nAlmaz T.,0911223344,Sidama,coffee farming,8000,2000,2026-12-01,4'} style={{ minHeight: 140 }} />
          <div className="actions" style={{ marginTop: 8 }}>
            <button disabled={!manager || !csv.trim()} onClick={async () => { setError(null); try { setPreview(await api<ImportPreview>('/api/import/preview', { method: 'POST', body: { csv } })); } catch (e) { setError((e as Error).message); } }}>Read columns</button>
          </div>
          {preview && (
            <div style={{ marginTop: 12 }}>
              <table>
                <thead><tr><th>Field</th><th>Your column</th></tr></thead>
                <tbody>
                  {Object.keys(FIELD_LABEL).map((f) => (
                    <tr key={f}>
                      <td>{FIELD_LABEL[f]}</td>
                      <td>
                        <select value={preview.mapping[f] ?? ''} onChange={(e) => setPreview({ ...preview, mapping: { ...preview.mapping, [f]: e.target.value } })}>
                          <option value="">Not in my sheet</option>
                          {preview.headers.map((h) => <option key={h} value={h}>{h}</option>)}
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="muted small" style={{ marginTop: 8 }}>
                Mapped by {preview.mappedBy === 'gemini' ? 'Gemini' : 'column-name rules'}. {preview.readable} of {preview.readable + preview.problems.length} rows readable.
                {preview.problems.length > 0 && ` Problems: ${preview.problems.slice(0, 3).map((p) => `row ${p.row}: ${p.reason}`).join('; ')}.`}
              </p>
              <button className="primary" style={{ marginTop: 8 }} onClick={async () => { const r = await api<{ imported: number }>('/api/import/commit', { method: 'POST', body: { csv, mapping: preview.mapping } }); setImported(`Imported ${r.imported} loans.`); }}>Import loans</button>
              {imported && <p className="notice ok" style={{ marginTop: 8 }}>{imported}</p>}
            </div>
          )}
        </section>
      </div>
    </>
  );
}
