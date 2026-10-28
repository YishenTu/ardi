import type { ChatMessage, ModelState, PiCommand, ThinkingLevel } from "../chat";
import { joinParts, type BridgeEvent, type BridgeRequest } from "../bridge/protocol";
import { plainMentions } from "../mention";
import { NATIVE_HOST, type LiveItem, type PanelUpdate, type PiStatus, type SessionMeta } from "../shared";
import { loadSettings } from "./settings";
import * as store from "./store";

// Owns the bridge connection (one pi process) and the current chat. Lives in
// the service worker, so it keeps running when the side panel is closed. An
// open native port keeps the service worker alive (Chrome 105+).
//
// pi's session file is the record of the conversation: on start the bridge
// returns its history, and `live` holds what happened since. Only the chat
// list is stored here (IndexedDB).
const TITLE_LEN = 60;

let port: chrome.runtime.Port | null = null;
let status: PiStatus = "disconnected";
let session: SessionMeta;
// null while a saved chat's history hasn't arrived yet.
let history: ChatMessage[] | null = [];
let live: LiveItem[] = [];
// Kept across restarts and chat switches; the next `ready` refreshes it.
let model: ModelState = { models: [] };
let commands: PiCommand[] = [];
// `start`s and `open`s the bridge hasn't answered with `ready` yet. Until the
// latest one is answered, what pi sends belongs to a chat the user left: a
// switch stops the run first, and its last output arrives before `ready`.
let opening = 0;
const panels = new Set<chrome.runtime.Port>();

// A new chat lives only in memory until its first message; then it's stored
// and joins the chat list. Drafts have id 0 (IndexedDB ids start at 1).
const DRAFT_ID = 0;

function draft(): SessionMeta {
  const now = Date.now();
  return { id: DRAFT_ID, title: "", createdAt: now, updatedAt: now };
}

function isDraft(meta: SessionMeta): boolean {
  return meta.id === DRAFT_ID;
}

// The chat that's open, in chrome.storage.local, so a restarted worker
// (browser restart, extension reload) comes back to it, even to a new chat
// that is still a draft. Without one: the most recent chat, or a new one.
const CURRENT_CHAT = "currentChat";

const ready: Promise<void> = (async () => {
  const { [CURRENT_CHAT]: id } = await chrome.storage.local.get(CURRENT_CHAT);
  if (id === DRAFT_ID) return void (session = draft());
  const saved = typeof id === "number" ? await store.getSession(id) : undefined;
  session = saved ?? (await store.listSessions())[0] ?? draft();
  history = isDraft(session) ? [] : null;
})();

function setSession(next: SessionMeta) {
  session = next;
  void chrome.storage.local.set({ [CURRENT_CHAT]: next.id });
}

function broadcast(update: PanelUpdate) {
  for (const p of panels) p.postMessage(update);
}

function setStatus(s: PiStatus) {
  status = s;
  broadcast({ kind: "status", status });
}

async function sessionsUpdate(): Promise<PanelUpdate> {
  return { kind: "sessions", sessions: await store.listSessions(), currentId: session.id };
}

async function broadcastSessions() {
  broadcast(await sessionsUpdate());
}

function replay(): PanelUpdate {
  return { kind: "replay", status, session, history, live, model, commands };
}

function pushLive(item: LiveItem) {
  live.push(item);
  broadcast({ kind: "live", item });
}

function post(request: BridgeRequest) {
  port?.postMessage(request);
}

async function onBridgeEvent(event: BridgeEvent) {
  switch (event.type) {
    case "ready":
      opening = Math.max(0, opening - 1);
      if (opening) break;
      // The bridge reports the session pi is on; for a new chat that's the
      // first time Ardi learns its file.
      if (event.sessionFile !== session.piSessionFile) {
        session.piSessionFile = event.sessionFile;
        if (!isDraft(session)) await store.putSession(session);
      }
      // History is everything pi saved before this start; prompts sent while
      // pi was starting stay in `live` (the bridge holds them until ready).
      history = event.history;
      model = event.model;
      commands = event.commands;
      setStatus("connected");
      broadcast(replay());
      break;
    case "history":
      // Only for the chat on screen, and only until pi's own `ready`.
      if (event.sessionFile !== session.piSessionFile || history) break;
      history = event.history;
      broadcast(replay());
      break;
    case "model":
      model = event.model;
      broadcast({ kind: "model", model });
      break;
    case "chunk":
      if (!opening) pushLive({ kind: "chunk", chunk: event.chunk });
      break;
    case "fatal":
      pushLive({ kind: "chunk", chunk: { type: "notice", content: event.message, level: "error" } });
      break;
    case "pi_check":
      // Only sent to settings' own one-shot port (settings.ts).
      break;
  }
}

export async function start() {
  await ready;
  if (port) return;
  setStatus("connecting");
  live = [];
  const p = chrome.runtime.connectNative(NATIVE_HOST);
  p.onMessage.addListener(joinParts((event) => void onBridgeEvent(event)));
  p.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError?.message;
    if (err) console.warn("pi bridge disconnected:", err);
    if (port === p) {
      port = null;
      setStatus("disconnected");
    }
  });
  port = p;
  opening = 1;
  // Read after `port` is set, so a second start() meanwhile is a no-op.
  const { piPath } = await loadSettings();
  if (port === p) post({ type: "start", sessionFile: session.piSessionFile, piPath: piPath || undefined });
}

// Restarts the pi process; pi resumes the same session. Also applies
// changed settings.
export async function restart() {
  port?.disconnect();
  port = null;
  setStatus("disconnected");
  await start();
}

// pi keeps running and switches session in place; `ready` brings the history.
async function switchTo(next: SessionMeta) {
  setSession(next);
  history = isDraft(next) ? [] : null;
  live = [];
  broadcast(replay());
  await broadcastSessions();
  if (port) {
    opening++;
    post({ type: "open", sessionFile: session.piSessionFile });
  } else await start();
}

export async function newSession() {
  await ready;
  if (!isDraft(session)) await switchTo(draft());
}

export async function switchSession(id: number) {
  await ready;
  const meta = await store.getSession(id);
  if (meta && meta.id !== session.id) await switchTo(meta);
}

export async function deleteSession(id: number) {
  await ready;
  await store.deleteSession(id);
  if (id !== session.id) return broadcastSessions();
  const [latest] = await store.listSessions();
  await switchTo(latest ?? draft());
}

export async function prompt(text: string) {
  await start();
  session.updatedAt = Date.now();
  if (isDraft(session)) {
    // First message: the chat becomes real and joins the list.
    const draft = session;
    const { id: _, ...meta } = draft;
    const stored = await store.addSession({ ...meta, title: plainMentions(text).slice(0, TITLE_LEN) });
    // `ready` can name the session file while the chat is being stored.
    setSession({ ...stored, piSessionFile: draft.piSessionFile });
    if (session.piSessionFile !== stored.piSessionFile) await store.putSession(session);
    queueMicrotask(() => void broadcastSessions());
  } else {
    await store.putSession(session);
  }
  pushLive({ kind: "prompt", text, at: Date.now() });
  post({ type: "prompt", text });
}

export function abort() {
  post({ type: "abort" });
}

export function compact() {
  post({ type: "compact" });
}

export function setModel(provider: string, modelId: string) {
  post({ type: "set_model", provider, modelId });
}

export function setThinkingLevel(level: ThinkingLevel) {
  post({ type: "set_thinking_level", level });
}

export async function attachPanel(p: chrome.runtime.Port) {
  panels.add(p);
  p.onDisconnect.addListener(() => panels.delete(p));
  await ready;
  p.postMessage(replay());
  p.postMessage(await sessionsUpdate());
}
