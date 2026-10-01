/**
 * All persistence stays in the browser via IndexedDB - images and ICC profiles
 * are never uploaded. Two object stores:
 *
 *  projects  - full working state incl. original image bytes, embedded ICC,
 *              chosen source/target profile ids, settings and preview caches.
 *  profiles  - operator's ICC library (plus first-run seeded open profiles).
 */
import type { RenderingIntent } from '../color/lcms';
import type { ColorSpaceKind } from '../icc/profileInfo';

const DB_NAME = 'softproof-bench';
const DB_VERSION = 1;
export const STORE_PROJECTS = 'projects';
export const STORE_PROFILES = 'profiles';

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
