import type { Collection, Store } from '../ports.js';

/**
 * Write-through cache over a store. Each collection is read once, on first
 * use; after that reads come from memory and writes go to both. With a
 * single server instance this keeps Firestore reads far inside the free
 * tier while every change is still saved.
 */
class CachedCollection<T extends { id: string; lenderId?: string }> implements Collection<T> {
  private items = new Map<string, T>();
  private loaded = new Map<string, Promise<void>>();

  constructor(private inner: Collection<T>) {}

  private ensure(lenderId: string) {
    let p = this.loaded.get(lenderId);
    if (!p) {
      p = this.inner.list(lenderId).then((rows) => {
        for (const r of rows) this.items.set(r.id, r);
      });
      this.loaded.set(lenderId, p);
    }
    return p;
  }

  async get(id: string) {
    const hit = this.items.get(id);
    if (hit) return structuredClone(hit);
    const item = await this.inner.get(id);
    if (item) this.items.set(id, item);
    return item ? structuredClone(item) : undefined;
  }

  async put(item: T) {
    this.items.set(item.id, structuredClone(item));
    await this.inner.put(item);
  }

  async list(lenderId: string) {
    await this.ensure(lenderId);
    const out: T[] = [];
    for (const i of this.items.values()) if (!i.lenderId || i.lenderId === lenderId) out.push(structuredClone(i));
    return out;
  }
}

export function cachedStore(inner: Store): Store {
  return Object.fromEntries(Object.entries(inner).map(([k, c]) => [k, new CachedCollection(c as Collection<{ id: string }>)])) as unknown as Store;
}
