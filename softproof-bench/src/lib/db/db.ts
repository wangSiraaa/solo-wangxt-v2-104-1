/**
 * All persistence stays in the browser via IndexedDB - images and ICC profiles
 * are never uploaded. Object stores:
 *
 *  projects    - full working state incl. original image bytes, embedded ICC,
 *                chosen source/target profile ids, settings and preview caches.
 *  profiles    - operator's ICC library (plus first-run seeded open profiles).
 *  batches     - batch proofing jobs (meta + batch-level defaults).
 *  batchItems  - one record per batch entry: frozen original bytes, frozen
 *                source/target settings, status, attempts and the persisted
 *                conversion result, so unfinished work survives a refresh.
 */
import type { RenderingIntent } from '../color/lcms';
import type { ColorSpaceKind } from '../icc/profileInfo';

const DB_NAME = 'softproof-bench';
const DB_VERSION = 2;
export const STORE_PROJECTS = 'projects';
export const STORE_PROFILES = 'profiles';
export const STORE_BATCHES = 'batches';
export const STORE_BATCH_ITEMS = 'batchItems';

export interface StoredProfile {
  id: string;
  bytes: Uint8Array;
  description: string;
  colorSpace: ColorSpaceKind;
  channels: number;
  origin: 'builtin-open' | 'user-imported';
  addedAt: string;
  size: number;
}

export interface StoredProject {
  id: string;
  name: string;
  updatedAt: string;
  imageBytes: Uint8Array;
  imageName: string;
  embeddedICC?: Uint8Array;
  /** id into profiles store, or null until the operator chooses one. */
  sourceProfileId: string | null;
  sourceIsEmbedded: boolean;
  sourceAssumptionNote?: string;
  targetProfileId: string | null;
  intent: RenderingIntent;
  blackPointCompensation: boolean;
  provenanceSeen?: boolean; // image already carried a conversion marker
  previewCache?: {
    paramsKey: string;
    rgba: Uint8Array;
  };
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_PROJECTS)) {
        db.createObjectStore(STORE_PROJECTS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_PROFILES)) {
        db.createObjectStore(STORE_PROFILES, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_BATCHES)) {
        db.createObjectStore(STORE_BATCHES, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_BATCH_ITEMS)) {
        const items = db.createObjectStore(STORE_BATCH_ITEMS, { keyPath: 'id' });
        items.createIndex('by-batch', 'batchId', { unique: false });
        items.createIndex('by-status', 'status', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

export async function idbPut<T>(store: string, value: T): Promise<unknown> {
  return tx(store, 'readwrite', (s) => s.put(value));
}
export async function idbGet<T>(store: string, key: string): Promise<T | undefined> {
  return tx(store, 'readonly', (s) => s.get(key) as IDBRequest<T | undefined>);
}
export async function idbDelete(store: string, key: string): Promise<void> {
  await tx(store, 'readwrite', (s) => s.delete(key));
}
export async function idbAll<T>(store: string): Promise<T[]> {
  return tx(store, 'readonly', (s) => s.getAll() as IDBRequest<T[]>);
}
export async function idbKeys(store: string): Promise<string[]> {
  return tx(store, 'readonly', (s) => s.getAllKeys() as IDBRequest<IDBValidKey[]>).then((k) => k.map(String));
}

/** All records matching an index value (e.g. batchItems of one batch). */
export async function idbAllByIndex<T>(store: string, index: string, value: IDBValidKey): Promise<T[]> {
  return openDb().then(
    (db) =>
      new Promise<T[]>((resolve, reject) => {
        const t = db.transaction(store, 'readonly');
        const req = t.objectStore(store).index(index).getAll(value);
        req.onsuccess = () => resolve(req.result as T[]);
        req.onerror = () => reject(req.error);
      }),
  );
}

/**
 * Atomic read-modify-write inside a single readwrite transaction. Status
 * transitions (cancel vs. late worker result, retry vs. refresh recovery)
 * must go through this so concurrent writers can never interleave between
 * the check and the write. Returning undefined skips the write.
 */
export async function idbUpdate<T>(
  store: string,
  key: string,
  updater: (current: T | undefined) => T | undefined,
): Promise<T | undefined> {
  const db = await openDb();
  return new Promise<T | undefined>((resolve, reject) => {
    const t = db.transaction(store, 'readwrite');
    const s = t.objectStore(store);
    const getReq = s.get(key);
    let next: T | undefined;
    getReq.onsuccess = () => {
      next = updater(getReq.result as T | undefined);
      if (next !== undefined) s.put(next);
    };
    t.oncomplete = () => resolve(next);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}
