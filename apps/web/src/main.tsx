import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, NavLink, Navigate, Route, Routes } from 'react-router-dom';
import type { User } from 'firebase/auth';
import { api, DEMO_AUTH, setDemoRole, signIn, signOutUser, watchUser } from './api';
import { Approvals } from './pages/Approvals';
import { Case } from './pages/Case';
import { Ask, Performance, Portfolio, Sandbox, Setup } from './pages/Manager';
import { Today } from './pages/Today';
import './styles.css';

function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="login">
      <form
        className="sheet"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await signIn(email, password);
          } catch {
            setError('That email and password do not match an account.');
            setBusy(false);
          }
        }}
      >
        <h1>Collections Officer</h1>
        <p className="muted" style={{ marginBottom: 16 }}>Sign in to see today’s cases.</p>
        <div className="field"><label htmlFor="em">Email</label><input id="em" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required /></div>
        <div className="field"><label htmlFor="pw">Password</label><input id="pw" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></div>
        {error && <p className="notice err" style={{ marginBottom: 12 }}>{error}</p>}
        <button className="primary" disabled={busy} style={{ width: '100%', justifyContent: 'center' }}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
    </div>
  );
}

function Shell({ role, email, onSwitch }: { role: 'officer' | 'manager'; email: string | null; onSwitch?: () => void }) {
  const [pending, setPending] = useState(0);
  useEffect(() => {
    api<{ messages: unknown[]; plans: unknown[] }>('/api/approvals')
      .then((d) => setPending(d.messages.length + d.plans.length))
      .catch(() => undefined);
  }, []);
  const manager = role === 'manager';
  return (
    <div className="shell">
      <nav className="nav" aria-label="Main">
        <div className="brand">
          <svg width="28" height="28" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="7" fill="#f3f5f2" /><g fill="#1f5c4a"><rect x="7" y="9" width="4" height="14" rx="1" /><rect x="14" y="13" width="4" height="10" rx="1" opacity=".75" /><rect x="21" y="17" width="4" height="6" rx="1" opacity=".5" /></g></svg>
          <div>Collections Officer<small>Demo Lender</small></div>
        </div>
        <NavLink to="/" end>Today</NavLink>
        <NavLink to="/approvals">Approvals {pending > 0 && <span className="badge">{pending}</span>}</NavLink>
        {manager && (
          <>
            <div className="group">Manager</div>
            <NavLink to="/portfolio">Portfolio</NavLink>
            <NavLink to="/ask">Ask the agent</NavLink>
            <NavLink to="/sandbox">Policy sandbox</NavLink>
            <NavLink to="/performance">Agent performance</NavLink>
          </>
        )}
        <NavLink to="/setup">Setup</NavLink>
        <div className="foot">
          {email ?? (manager ? 'Manager (demo)' : 'Officer (demo)')}
          <div>
            {onSwitch ? (
              <button onClick={onSwitch}>Switch to {manager ? 'officer' : 'manager'} view</button>
            ) : (
              <button onClick={() => void signOutUser()}>Sign out</button>
            )}
          </div>
        </div>
      </nav>
      <main className="main">
        <Routes>
          <Route path="/" element={<Today role={role} />} />
          <Route path="/approvals" element={<Approvals role={role} />} />
          <Route path="/cases/:id" element={<Case />} />
          <Route path="/portfolio" element={manager ? <Portfolio /> : <Navigate to="/" />} />
          <Route path="/ask" element={manager ? <Ask /> : <Navigate to="/" />} />
          <Route path="/sandbox" element={manager ? <Sandbox /> : <Navigate to="/" />} />
          <Route path="/performance" element={manager ? <Performance /> : <Navigate to="/" />} />
          <Route path="/setup" element={<Setup role={role} />} />
        </Routes>
      </main>
    </div>
  );
}

function App() {
  const [user, setUser] = useState<User | null | undefined>(DEMO_AUTH ? null : undefined);
  const [role, setRole] = useState<'officer' | 'manager' | null>(DEMO_AUTH ? 'manager' : null);

  useEffect(() => {
    if (DEMO_AUTH) return;
    return watchUser(async (u) => {
      setUser(u);
      if (u) setRole((await api<{ role: 'officer' | 'manager' }>('/api/me')).role);
      else setRole(null);
    });
  }, []);

  if (DEMO_AUTH && role) {
    return (
      <Shell
        key={role}
        role={role}
        email={null}
        onSwitch={() => {
          const next = role === 'manager' ? 'officer' : 'manager';
          setDemoRole(next);
          setRole(next);
        }}
      />
    );
  }
  if (user === undefined) return <p className="muted" style={{ padding: 32 }}>Loading…</p>;
  if (!user) return <Login />;
  if (!role) return <p className="muted" style={{ padding: 32 }}>Loading…</p>;
  return <Shell role={role} email={user.email} />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
