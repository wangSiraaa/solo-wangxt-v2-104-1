/**
 * All persistence stays in the browser via IndexedDB - images and ICC profiles
 * are never uploaded. Object stores:
 *
 *  projects       - v1: full single-image working state.
 *  profiles       - v1: operator's ICC library (plus seeded open profiles).
 *  batch-jobs     - v2: batch proofing job metadata (frozen defaults, status).
 *  batch-items    - v2: per-image frozen original bytes, frozen settings,
 *                    status and the full attempt history (never rewritten).
 *  batch-outputs  - v2: converted outputs keyed by (itemId, attemptId), so a
 *                    retry creates a NEW output and the old failure is kept.
 */
import type { RenderingIntent } from '../color/intents';
import type { ColorSpaceKind } from '../icc/profileInfo';
import type { BatchItemStatus, FrozenProfile, BatchAttempt } from '../batch/types';

const DB_NAME = 'softproof-bench';
const DB_VERSION = 2;
export const STORE_PROJECTS = 'projects';
export const STORE_PROFILES = 'profiles';
export const STORE_BATCH_JOBS = 'batch-jobs';
export const STORE_BATCH_ITEMS = 'batch-items';
export const STORE_BATCH_OUTPUTS = 'batch-outputs';

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

// ----- batch proofing stores -------------------------------------------------

export interface StoredBatchJob {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  /** Frozen default settings applied to new embedded entries. */
  defaults: {
    /** null until the operator picks a batch default target. */
    target: FrozenProfile | null;
    intent: RenderingIntent;
    blackPointCompensation: boolean;
    proofIntent: RenderingIntent;
  };
  canceledAll: boolean;
}

export interface StoredBatchItem {
  id: string;
  jobId: string;
  createdAt: string;
  updatedAt: string;
  ordinal: number;
  // --- frozen original master bytes (never mutated; never a conversion) ---
  imageBytes: Uint8Array;
  imageName: string;
  container: string;
  bitDepth: 8 | 16;
  width: number | null;
  height: number | null;
  pixelHash: string;
  embeddedProfile: FrozenProfile | null;
  provenanceConverted: boolean;
  // --- frozen effective settings (null while awaiting confirmation) ---
  source: FrozenProfile | null;
  sourceIsAssumption: boolean;
  target: FrozenProfile | null;
  intent: RenderingIntent | null;
  blackPointCompensation: boolean | null;
  proofIntent: RenderingIntent | null;
  /** Bumped whenever frozen settings change; late results are bound to one revision. */
  settingsRevision: number;
  status: BatchItemStatus;
  /** attempts in order; a retry appends, never overwrites. */
  attempts: BatchAttempt[];
  /** id of the successful attempt (== an attempts entry; unique, terminal). */
  successfulAttemptId: string | null;
  error: string | null;
}

export interface StoredBatchOutput {
  key: string; // `${itemId}:${attemptId}`
  jobId: string;
  itemId: string;
  attemptId: string;
  createdAt: string;
  width: number;
  height: number;
  bitDepth: 8 | 16;
  targetColorSpace: ColorSpaceKind;
  converted: Uint8Array;
  convertedColorChannels: 1 | 3 | 4;
  convertedChannels: number;
  softProofRGBA: Uint8Array;
  hasAlpha: boolean;
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
      if (!db.objectStoreNames.contains(STORE_BATCH_JOBS)) {
        db.createObjectStore(STORE_BATCH_JOBS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_BATCH_ITEMS)) {
        const s = db.createObjectStore(STORE_BATCH_ITEMS, { keyPath: 'id' });
        s.createIndex('jobId', 'jobId');
      }
      if (!db.objectStoreNames.contains(STORE_BATCH_OUTPUTS)) {
        const s = db.createObjectStore(STORE_BATCH_OUTPUTS, { keyPath: 'key' });
        s.createIndex('jobId', 'jobId');
        s.createIndex('itemId', 'itemId');
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

async function txAll<T>(stores: string[], fn: (ss: IDBObjectStore[]) => void): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction(stores, 'readwrite');
    const ss = stores.map((name) => t.objectStore(name));
    fn(ss);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
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

export async function idbGetAllByIndex<T>(store: string, index: string, value: string): Promise<T[]> {
  const db = await openDb();
  return new Promise<T[]>((resolve, reject) => {
    const t = db.transaction(store, 'readonly');
    const req = t.objectStore(store).index(index).getAll(value);
    req.onsuccess = () => resolve(req.result as T[]);
    req.onerror = () => reject(req.error);
  });
}

/** Atomic multi-store commit (item + its output are persisted together). */
export async function idbAtomicPut(puts: { store: string; value: unknown }[]): Promise<void> {
  const names = [...new Set(puts.map((p) => p.store))];
  await txAll(names, (ss) => {
    for (const p of puts) ss[names.indexOf(p.store)].put(p.value);
  });
}
