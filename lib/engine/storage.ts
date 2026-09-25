/*
 * IndexedDB persistence for the processed data. Everything stays in this
 * browser profile on this computer; nothing is sent to a server.
 */
const DB_NAME = "fc-map-local-data";
const STORE = "entries";
const DB_VERSION = 1;

export type StorageKey = "dataset" | "tce" | "revenue" | "folderHandle";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB could not be opened."));
  });
}

async function withStore<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await openDb();
  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      const transaction = db.transaction(STORE, mode);
      const request = action(transaction.objectStore(STORE));
      transaction.oncomplete = () => resolve(request ? request.result : undefined);
      transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed."));
      transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction was aborted."));
    });
  } finally {
    db.close();
  }
}

export async function loadEntry<T>(key: StorageKey): Promise<T | null> {
  try {
    return ((await withStore<T>("readonly", (store) => store.get(key) as IDBRequest<T>)) ?? null) as T | null;
  } catch {
    return null;
  }
}

export async function saveEntry(key: StorageKey, value: unknown) {
  await withStore("readwrite", (store) => { store.put(value, key); });
}

export async function clearEntries() {
  await withStore("readwrite", (store) => { store.clear(); });
}
