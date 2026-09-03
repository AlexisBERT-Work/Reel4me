import type { Interaction } from './types';
import { sendInteractions } from './supabase';

/**
 * File d'attente des interactions.
 *
 * Le feed doit rester utilisable en mode avion : on ecrit d'abord en local,
 * on pousse vers Supabase quand le reseau revient. IndexedDB plutot que
 * localStorage pour ne pas bloquer le thread principal pendant le scroll.
 */

const DB_NAME = 'reel4me';
const STORE = 'pending';

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) {
          req.result.createObjectStore(STORE, { autoIncrement: true });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const request = fn(db.transaction(STORE, mode).objectStore(STORE));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      }),
  );
}

let flushing = false;

export async function record(interaction: Interaction): Promise<void> {
  try {
    await tx('readwrite', (store) => store.add(interaction));
  } catch {
    // Navigation privee ou stockage refuse : on perd le signal, pas la session.
    return;
  }
  void flush();
}

export async function flush(): Promise<void> {
  if (flushing || !navigator.onLine) return;
  flushing = true;

  try {
    const keys = await tx<IDBValidKey[]>('readonly', (store) => store.getAllKeys());
    if (!keys.length) return;

    const rows = await tx<Interaction[]>('readonly', (store) => store.getAll());

    // Si l'envoi echoue, on garde tout : un doublon d'interaction est sans
    // consequence, une perte fausse la ponderation du lendemain.
    await sendInteractions(rows);

    await open().then(
      (db) =>
        new Promise<void>((resolve, reject) => {
          const store = db.transaction(STORE, 'readwrite').objectStore(STORE);
          for (const key of keys) store.delete(key);
          store.transaction.oncomplete = () => resolve();
          store.transaction.onerror = () => reject(store.transaction.error);
        }),
    );
  } catch {
    // Reseau ou Supabase indisponible : on retentera au prochain evenement.
  } finally {
    flushing = false;
  }
}

export function watchConnectivity(): () => void {
  const onOnline = () => void flush();
  const onVisible = () => {
    if (document.visibilityState === 'visible') void flush();
  };

  window.addEventListener('online', onOnline);
  document.addEventListener('visibilitychange', onVisible);
  void flush();

  return () => {
    window.removeEventListener('online', onOnline);
    document.removeEventListener('visibilitychange', onVisible);
  };
}

/* ------------------------------------------------- cartes deja vues */

const SEEN_KEY = 'reel4me:seen';

export function loadSeen(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(SEEN_KEY) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

export function saveSeen(seen: Set<string>): void {
  try {
    // Borne : au-dela, on laisse les plus anciennes ressortir. Le feed ne
    // doit pas se tarir a cause d'un historique trop long.
    localStorage.setItem(SEEN_KEY, JSON.stringify([...seen].slice(-3000)));
  } catch {
    // Quota plein : sans consequence, on reverra quelques cartes.
  }
}
