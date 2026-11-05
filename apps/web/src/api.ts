import { initializeApp } from 'firebase/app';
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut, type User } from 'firebase/auth';
import { firebaseConfig } from './firebaseConfig';

/**
 * API client. In production the dashboard signs in with Firebase and sends
 * the ID token; in local demo mode (VITE_AUTH_MODE=demo) it sends a role header.
 */
const API = import.meta.env.VITE_API_URL ?? '';
export const DEMO_AUTH = import.meta.env.VITE_AUTH_MODE === 'demo';

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);

let demoRole: 'officer' | 'manager' = 'manager';
export function setDemoRole(r: 'officer' | 'manager') {
  demoRole = r;
}

export function watchUser(cb: (u: User | null) => void) {
  return onAuthStateChanged(auth, cb);
}
export const signIn = (email: string, password: string) => signInWithEmailAndPassword(auth, email, password);
export const signOutUser = () => signOut(auth);

async function headers(): Promise<Record<string, string>> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (DEMO_AUTH) h['X-Demo-Role'] = demoRole;
  else if (auth.currentUser) h.Authorization = `Bearer ${await auth.currentUser.getIdToken()}`;
  return h;
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: init.method ?? 'GET',
    headers: await headers(),
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `Request failed (${res.status})`);
  return data as T;
}

export const birr = (cents: number) =>
  `${(cents / 100).toLocaleString('en-US', { maximumFractionDigits: cents % 100 ? 2 : 0 })} birr`;
export const pct = (x: number) => `${Math.round(x * 100)}%`;
export const shortDate = (iso: string) =>
  new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
