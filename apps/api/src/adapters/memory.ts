import { randomUUID } from 'node:crypto';
import type { Collection, Store } from '../ports.js';

class MemoryCollection<T extends { id: string; lenderId?: string }> implements Collection<T> {
  private items = new Map<string, T>();

  async get(id: string) {
    const item = this.items.get(id);
    return item ? structuredClone(item) : undefined;
  }

  async put(item: T) {
    this.items.set(item.id, structuredClone(item));
  }

  async list(lenderId: string) {
    return [...this.items.values()].filter((i) => !i.lenderId || i.lenderId === lenderId).map((i) => structuredClone(i));
  }
}

export function memoryStore(): Store {
  return {
    lenders: new MemoryCollection(),
    borrowers: new MemoryCollection(),
    loans: new MemoryCollection(),
    payments: new MemoryCollection(),
    plans: new MemoryCollection(),
    messages: new MemoryCollection(),
    runs: new MemoryCollection(),
    signals: new MemoryCollection(),
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
