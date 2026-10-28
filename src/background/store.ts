import type { SessionMeta } from "../shared";

// IndexedDB storage for Ardi's chat list. Lives in the service worker.
// Only metadata: the conversation itself is in pi's session file.
//
//   sessions: SessionMeta, keyed by an auto-increment id
const DB_NAME = "ardi";
const DB_VERSION = 3;

let dbPromise: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      // Pre-release: drop older layouts instead of migrating them.
      for (const name of Array.from(d.objectStoreNames)) d.deleteObjectStore(name);
      d.createObjectStore("sessions", { keyPath: "id", autoIncrement: true }).createIndex("updatedAt", "updatedAt");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}

function result<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// Newest first.
export async function listSessions(): Promise<SessionMeta[]> {
  const tx = (await db()).transaction("sessions");
  const rows = await result(tx.objectStore("sessions").index("updatedAt").getAll());
  return (rows as SessionMeta[]).reverse();
}

export async function getSession(id: number): Promise<SessionMeta | undefined> {
  const tx = (await db()).transaction("sessions");
  return result(tx.objectStore("sessions").get(id));
}

export async function putSession(meta: SessionMeta): Promise<void> {
  const tx = (await db()).transaction("sessions", "readwrite");
  tx.objectStore("sessions").put(meta);
  await done(tx);
}

// Inserts a new session and returns it with its assigned id.
export async function addSession(meta: Omit<SessionMeta, "id">): Promise<SessionMeta> {
  const tx = (await db()).transaction("sessions", "readwrite");
  const id = (await result(tx.objectStore("sessions").add(meta))) as number;
  await done(tx);
  return { ...meta, id };
}

// Removes Ardi's entry only; pi's session file stays.
export async function deleteSession(id: number): Promise<void> {
  const tx = (await db()).transaction("sessions", "readwrite");
  tx.objectStore("sessions").delete(id);
  await done(tx);
}
