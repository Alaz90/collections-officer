import { applicationDefault, cert, getApps, initializeApp, type App } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import type { Collection, Store } from '../ports.js';

class FirestoreCollection<T extends { id: string }> implements Collection<T> {
  constructor(
    private db: Firestore,
    private name: string,
  ) {}

  async get(id: string) {
    const snap = await this.db.collection(this.name).doc(id).get();
    return snap.exists ? (snap.data() as T) : undefined;
  }

  async put(item: T) {
    // Firestore rejects undefined fields; drop them.
    await this.db.collection(this.name).doc(item.id).set(JSON.parse(JSON.stringify(item)));
  }

  async list(lenderId: string) {
    const snap =
      this.name === 'lenders'
        ? await this.db.collection(this.name).get()
        : await this.db.collection(this.name).where('lenderId', '==', lenderId).get();
    return snap.docs.map((d) => d.data() as T);
  }
}

/**
 * Firebase app. On Google hosts it uses the default credentials; elsewhere
 * (Render), FIREBASE_SERVICE_ACCOUNT holds the service account JSON as an
 * environment secret.
 */
export function firebaseApp(projectId?: string, serviceAccountJson?: string): App {
  const existing = getApps()[0];
  if (existing) return existing;
  const credential = serviceAccountJson ? cert(JSON.parse(serviceAccountJson)) : applicationDefault();
  return initializeApp({ credential, projectId });
}

export function firestoreStore(app: App): Store {
  const db = getFirestore(app);
  const c = <T extends { id: string }>(name: string) => new FirestoreCollection<T>(db, name);
  return {
    lenders: c('lenders'),
    borrowers: c('borrowers'),
    loans: c('loans'),
    payments: c('payments'),
    plans: c('plans'),
    messages: c('messages'),
    runs: c('agent_runs'),
    signals: c('signals'),
  };
}
