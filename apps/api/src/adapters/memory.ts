import { randomUUID } from 'node:crypto';
import type { AgentRun, Borrower, Loan, Message, Payment, Plan, RegionSignal } from '@co/shared';
import type { Collection, Lender, Store } from '../ports.js';

class MemoryCollection<T extends { id: string; lenderId?: string }> implements Collection<T> {
  private items = new Map<string, T>();

  /** `copy` protects callers from shared mutation; the simulator turns it off for speed. */
  constructor(private copy: boolean) {}

  private c(item: T): T {
    return this.copy ? structuredClone(item) : item;
  }

  async get(id: string) {
    const item = this.items.get(id);
    return item ? this.c(item) : undefined;
  }

  async put(item: T) {
    this.items.set(item.id, this.c(item));
  }

  async list(lenderId: string) {
    const out: T[] = [];
    for (const i of this.items.values()) if (!i.lenderId || i.lenderId === lenderId) out.push(this.c(i));
    return out;
  }

  all() {
    return [...this.items.values()];
  }
}

export function memoryStore(opts: { copy?: boolean } = {}): Store {
  const copy = opts.copy ?? true;
  return {
    lenders: new MemoryCollection<Lender & { lenderId?: never }>(copy),
    borrowers: new MemoryCollection<Borrower>(copy),
    loans: new MemoryCollection<Loan>(copy),
    payments: new MemoryCollection<Payment>(copy),
    plans: new MemoryCollection<Plan>(copy),
    messages: new MemoryCollection<Message>(copy),
    runs: new MemoryCollection<AgentRun>(copy),
    signals: new MemoryCollection<RegionSignal & { id: string; lenderId: string }>(copy),
  };
}

export const uuid = () => randomUUID();

export function sequentialIds(prefix = 'id') {
  let n = 0;
  return () => `${prefix}${++n}`;
}

export function fixedClock(iso: string) {
  let now = new Date(iso);
  return {
    now: () => new Date(now),
    set: (next: string) => {
      now = new Date(next);
    },
  };
}
