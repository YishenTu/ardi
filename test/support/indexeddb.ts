// An in-memory IndexedDB on the global, for the background's chat list.
// Import before anything that opens the database.
import { IDBKeyRange, indexedDB } from "fake-indexeddb";

Object.assign(globalThis, { indexedDB, IDBKeyRange });
