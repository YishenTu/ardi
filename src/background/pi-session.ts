import type { ChatChunk, ChatMessage, ImageAttachment, ModelState, PiCommand, QueueAction, QueuedMessage, ThinkingLevel } from "../chat";
import type { BridgeEvent, BridgeRequest } from "../bridge/protocol";
import { plainMentions } from "../mention";
import { restoreOf } from "../restore";
import { joinParts, postInParts } from "../parts";
import type { PanelUpdate, PiStatus, SessionMeta } from "../panel-protocol";
import { loadSettings } from "./settings";
import * as store from "./store";
import { target, type BrowserLink } from "./target";

// Owns the chats and their bridge connections. Each chat with pi running has
// its own bridge (its own pi process, on that chat's session for life), so a
// chat the user leaves while pi works keeps going in the background. Lives in
// the service worker, so it keeps running when the side panel is closed. An
// open native port keeps the service worker alive (Chrome 105+).
//
// pi's session file is the record of the conversation: on start the bridge
// returns its history, and `live` holds what happened since. Only the chat
// list is stored here (IndexedDB).
const TITLE_LEN = 60;

// Messages sent to a bridge that pi hasn't answered yet, with the browser
// permission callback of the run they may start. If that bridge goes away
// first, they go back to the message box: the chat never showed them.
type Unanswered = Map<string, { text: string; images?: ImageAttachment[]; accept?: () => void }>;

// A chat's bridge connection: down, or a port (with the target's browser
// link for it, what it hasn't answered, and how many requests were sent on
// it) that is connecting until the bridge reports pi ready.
type Connection =
  | { state: "down" }
  | { state: "connecting" | "connected"; port: chrome.runtime.Port; browser: BrowserLink | null; unanswered: Unanswered; sent: number };

// Text and images for the message box.
type Returned = { text: string; images?: ImageAttachment[] }[];

// A chat and what its pi reported: the stored chat, pi's history for it
// (null while it loads), what pi sent since, what waits in pi's queue, and
// whether a run is going (for the chat list). `working`: the bridge's own
// report that it has work left, which decides when an off-screen chat's pi
// can stop.
type Chat = {
  meta: SessionMeta;
  history: ChatMessage[] | null;
  live: ChatChunk[];
  queue: QueuedMessage[];
  model: ModelState;
  commands: PiCommand[];
  running: boolean;
  working: boolean;
  connection: Connection;
  starting: Promise<void> | null;
};

// The chat on screen.
let chat: Chat;
// Chats off screen that pi still works on. Leaving an idle chat stops its pi;
// a chat that finishes off screen stops it then.
const away = new Set<Chat>();

// Text for the message box, held while no panel is open to take it, in
// chrome.storage.local: Chrome may stop the worker meanwhile.
const RETURNED = "returned";
// Text a chat handed back while off screen, by chat id, until the user
// comes back to it; in chrome.storage.local for the same reason.
const RETURNED_TO = "returnedTo";
type ReturnedTo = Record<string, Returned>;
// The last model and commands pi reported, shown for a chat until its own pi
// is up.
let lastModel: ModelState = { models: [] };
let lastCommands: PiCommand[] = [];
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

function opened(meta: SessionMeta): Chat {
  return {
    meta, history: isDraft(meta) ? [] : null, live: [], queue: [], model: lastModel, commands: lastCommands,
    running: false, working: false, connection: { state: "down" }, starting: null,
  };
}

// The chat that's open, in chrome.storage.local, so a restarted worker
// (browser restart, extension reload) comes back to it, even to a new chat
// that is still a draft. Without one: the most recent chat, or a new one.
const CURRENT_CHAT = "currentChat";

const ready: Promise<void> = (async () => {
  const { [CURRENT_CHAT]: id } = await chrome.storage.local.get(CURRENT_CHAT);
  const saved = typeof id === "number" && id !== DRAFT_ID ? await store.getSession(id) : undefined;
  chat = opened(id === DRAFT_ID ? draft() : (saved ?? (await store.listSessions())[0] ?? draft()));
})();

// Keeps chat `c`, under new metadata (it was stored, or got its file).
function setMeta(c: Chat, meta: SessionMeta) {
  c.meta = meta;
  if (c === chat) void chrome.storage.local.set({ [CURRENT_CHAT]: meta.id });
}

function status(c: Chat): PiStatus {
  return c.connection.state === "down" ? "disconnected" : c.connection.state;
}

function setConnection(c: Chat, next: Connection) {
  c.connection = next;
  toScreen(c, { kind: "status", status: status(c) });
}

function broadcast(update: PanelUpdate) {
  for (const p of panels) postInParts(p, update);
}

// Shown only while `c` is on screen; a chat off screen is replayed when the
// user comes back.
function toScreen(c: Chat, update: PanelUpdate) {
  if (c === chat) broadcast(update);
}

async function sessionsUpdate(): Promise<PanelUpdate> {
  const running = [chat, ...away].filter((c) => c.running && !isDraft(c.meta)).map((c) => c.meta.id);
  return { kind: "sessions", sessions: await store.listSessions(), currentId: chat.meta.id, running };
}

async function broadcastSessions() {
  broadcast(await sessionsUpdate());
}

function pushLive(c: Chat, chunk: ChatChunk) {
  c.live.push(chunk);
  toScreen(c, { kind: "live", chunk });
}

function replay(): PanelUpdate {
  return { kind: "replay", status: status(chat), session: chat.meta, history: chat.history, live: chat.live, queue: chat.queue, model: chat.model, commands: chat.commands };
}

// `c`'s bridge has work left, or hasn't yet answered a message sent to it.
// Only the bridge knows what it still has in hand (a run, a queue, input on
// its way to pi, a compaction), so nothing here guesses from pi's events.
function busy(c: Chat): boolean {
  return c.working || (c.connection.state !== "down" && c.connection.unanswered.size > 0);
}

// A chat off screen that pi is done with stops its pi and is dropped.
function settle(c: Chat) {
  if (c === chat || busy(c)) return;
  stop(c);
  away.delete(c);
}

// Shuts `c`'s bridge down; what it hasn't answered is dropped.
function stop(c: Chat) {
  const old = c.connection;
  c.connection = { state: "down" };
  idle(c);
  if (old.state === "down") return;
  old.unanswered.clear();
  void old.browser?.dispose();
  old.port.disconnect();
}

// A connection is going away: what it hasn't answered goes back.
function handBack(c: Chat, unanswered: Unanswered) {
  giveBack(c, [...unanswered.values()]);
  unanswered.clear();
}

// To the message box of the open panels, or the next one to open; text from
// a chat off screen waits for that chat.
let holding: Promise<void> = Promise.resolve();
function giveBack(c: Chat, messages: Returned) {
  if (!messages.length) return;
  if (c !== chat) return holdFor(c.meta.id, messages);
  const restore = restoreOf(messages);
  if (!restore) return;
  if (panels.size) return broadcast({ kind: "restore", ...restore });
  holding = holding.then(async () => {
    const { [RETURNED]: held = [] } = await chrome.storage.local.get(RETURNED);
    await chrome.storage.local.set({ [RETURNED]: [...(held as Returned), ...messages] });
  });
}

function holdFor(id: number, messages: Returned) {
  holding = holding.then(async () => {
    const { [RETURNED_TO]: held = {} } = await chrome.storage.local.get(RETURNED_TO);
    const to = held as ReturnedTo;
    await chrome.storage.local.set({ [RETURNED_TO]: { ...to, [id]: [...(to[id] ?? []), ...messages] } });
  });
}

// What chat `id` handed back while off screen, out of storage: to its
// message box if it's still on screen, else dropped (it was deleted).
function takeHeldFor(id: number, deliver: boolean) {
  holding = holding
    .then(async () => {
      const { [RETURNED_TO]: held = {} } = await chrome.storage.local.get(RETURNED_TO);
      const { [id]: mine, ...rest } = held as ReturnedTo;
      if (!mine || (deliver && chat.meta.id !== id)) return;
      // Handed over now, while its chat is known to be on screen.
      if (deliver) giveBack(chat, mine);
      await chrome.storage.local.set({ [RETURNED_TO]: rest });
    })
    .catch(() => undefined);
}

// Hands what was held to panel `p`; it stays held unless `p` got it.
async function handOver(p: chrome.runtime.Port) {
  holding = holding
    .then(async () => {
      const { [RETURNED]: held = [] } = await chrome.storage.local.get(RETURNED);
      const restore = restoreOf(held as Returned);
      if (!restore || !panels.has(p)) return;
      postInParts(p, { kind: "restore", ...restore });
      await chrome.storage.local.set({ [RETURNED]: [] });
    })
    .catch(() => undefined);
  await holding;
}

// `c` is unset only before the worker has read which chat is open. The
// bridge has work from the moment it's asked, before it says so.
function post(c: Chat | undefined, request: BridgeRequest) {
  if (!c || c.connection.state === "down") return;
  c.working = true;
  c.connection.sent++;
  postInParts(c.connection.port, request);
}

// `c`'s pi is gone: nothing runs or waits any more.
function idle(c: Chat) {
  setRunning(c, false);
  c.working = false;
  c.queue = [];
}

function setRunning(c: Chat, running: boolean) {
  if (c.running === running) return;
  c.running = running;
  void broadcastSessions();
}

async function onBridgeEvent(c: Chat, event: Exclude<BridgeEvent, { type: "browser_request" | "browser_cancel" }>) {
  switch (event.type) {
    case "prompt_result": {
      if (c.connection.state === "down") break;
      const sent = c.connection.unanswered.get(event.promptId);
      c.connection.unanswered.delete(event.promptId);
      if (event.started) sent?.accept?.();
      settle(c);
      break;
    }
    case "ready": {
      // The bridge reports the session pi is on; for a new chat that's the
      // first time Ardi learns its file.
      const { meta } = c;
      if (event.sessionFile !== meta.piSessionFile) {
        meta.piSessionFile = event.sessionFile;
        if (!isDraft(meta)) await store.putSession(meta);
      }
      // History is everything pi saved before it started.
      c.history = event.history;
      c.model = lastModel = event.model;
      c.commands = lastCommands = event.commands;
      if (c.connection.state === "connecting") c.connection = { ...c.connection, state: "connected" };
      toScreen(c, replay());
      break;
    }
    case "busy":
      // An idle report from before the latest request doesn't count.
      c.working = event.busy || (c.connection.state !== "down" && event.requests < c.connection.sent);
      settle(c);
      break;
    case "history":
      // Only until pi's own `ready`.
      if (c.history) break;
      c.history = event.history;
      toScreen(c, replay());
      break;
    case "model":
      c.model = lastModel = event.model;
      toScreen(c, { kind: "model", model: c.model });
      break;
    case "chunk":
      pushLive(c, event.chunk);
      if (event.chunk.type === "run_start") setRunning(c, true);
      if (event.chunk.type === "run_end") setRunning(c, false);
      break;
    case "queue":
      c.queue = event.queue;
      toScreen(c, { kind: "queue", queue: c.queue });
      break;
    case "restore":
      giveBack(c, [event]);
      break;
    case "fatal":
      pushLive(c, { type: "notice", content: event.message, level: "error" });
      if (c.connection.state !== "down") handBack(c, c.connection.unanswered);
      break;
    case "pi_check":
      // Only sent to settings' own one-shot port (settings.ts).
      break;
  }
}

// Connects `c`'s bridge and sends `start` in one go once settings are read,
// so a caller that awaited it finds the connection up (or down for good)
// with `start` already sent ahead of anything it posts. Calls meanwhile
// share it.
function startChat(c: Chat): Promise<void> {
  c.starting ??= connect(c).finally(() => (c.starting = null));
  return c.starting;
}

// Starts pi for the chat on screen.
export async function start(): Promise<void> {
  await ready;
  await startChat(chat);
}

async function connect(c: Chat) {
  if (c.connection.state !== "down") return;
  const { piPath } = await loadSettings();
  // Left while settings were read: no pi for a chat nobody tracks.
  if (c !== chat && !away.has(c)) return;
  // What pi sent belongs to the pi that's gone.
  c.live = [];
  idle(c);
  const p = chrome.runtime.connectNative(target().nativeHost);
  const unanswered: Unanswered = new Map();
  const isCurrent = () => c.connection.state !== "down" && c.connection.port === p;
  // Replies go only to the port that asked, not a replacement.
  const link = target().connectBrowser?.((reply) => { if (isCurrent()) postInParts(p, reply); }) ?? null;
  p.onMessage.addListener(joinParts<BridgeEvent>((event) => {
    if (!isCurrent()) return;
    if (event.type === "browser_request" || event.type === "browser_cancel") return link?.receive(event);
    void onBridgeEvent(c, event);
  }));
  p.onDisconnect.addListener(() => {
    void link?.dispose();
    const err = chrome.runtime.lastError?.message;
    if (err) console.warn("pi bridge disconnected:", err);
    handBack(c, unanswered);
    if (!isCurrent()) return;
    setConnection(c, { state: "down" });
    idle(c);
    settle(c);
  });
  setConnection(c, { state: "connecting", port: p, browser: link, unanswered, sent: 0 });
  post(c, { type: "start", sessionFile: c.meta.piSessionFile, piPath: piPath || undefined });
}

// What the panel and settings ask for runs one request at a time, in the
// order asked: a message still being stored must not land in a chat the user
// switched to meanwhile, nor be passed by a new chat. Stop and restart don't
// wait: a message being stored when pi restarts goes to the new pi.
let queue: Promise<unknown> = Promise.resolve();

function inOrder<A extends unknown[]>(run: (...args: A) => unknown): (...args: A) => Promise<void> {
  return (...args) => {
    const done = queue.then(() => run(...args)).then(() => undefined);
    queue = done.catch((error: unknown) => console.error("request failed:", error));
    return done;
  };
}

// Restarts the chat on screen's pi; pi resumes the same session. Also
// applies changed settings.
export async function restart() {
  await ready;
  const c = chat;
  const old = c.connection;
  setConnection(c, { state: "down" });
  idle(c);
  if (old.state !== "down") {
    handBack(c, old.unanswered);
    await old.browser?.dispose();
    old.port.disconnect();
  }
  await startChat(c);
}

// Puts `next` on screen: back to its chat if pi still works on it, else a
// fresh pi on its session. The chat left keeps its pi only while it's busy.
async function switchTo(next: SessionMeta, { stopLeft = false } = {}) {
  const left = chat;
  const back = isDraft(next) ? undefined : [...away].find((c) => c.meta.id === next.id);
  if (back) away.delete(back);
  chat = back ?? opened(next);
  void chrome.storage.local.set({ [CURRENT_CHAT]: next.id });
  broadcast(replay());
  if (stopLeft) stop(left);
  if (busy(left)) away.add(left);
  else stop(left);
  if (!isDraft(next)) takeHeldFor(next.id, true);
  await broadcastSessions();
  await startChat(chat);
}

export const newSession = inOrder(async () => {
  await ready;
  if (!isDraft(chat.meta)) await switchTo(draft());
});

export const switchSession = inOrder(async (id: number) => {
  await ready;
  const meta = await store.getSession(id);
  if (meta && meta.id !== chat.meta.id) await switchTo(meta);
});

export const deleteSession = inOrder(async (id: number) => {
  await ready;
  await store.deleteSession(id);
  takeHeldFor(id, false);
  for (const c of away) {
    if (c.meta.id !== id) continue;
    stop(c);
    away.delete(c);
  }
  if (id !== chat.meta.id) return broadcastSessions();
  const [latest] = await store.listSessions();
  await switchTo(latest ?? draft(), { stopLeft: true });
});

export const prompt = inOrder(async (text: string, images?: ImageAttachment[], steer = false) => {
  await ready;
  // The chat it was sent from, even if the user moves on meanwhile.
  const c = chat;
  await startChat(c);
  const origin = c.connection;
  const accept = origin.state !== "down" ? origin.browser?.preparePrompt() : undefined;
  const current = c.meta;
  current.updatedAt = Date.now();
  if (isDraft(current)) {
    // First message: the chat becomes real and joins the list.
    const { id: _, ...meta } = current;
    const stored = await store.addSession({ ...meta, title: plainMentions(text).slice(0, TITLE_LEN) });
    // `ready` can name the session file while the chat is being stored.
    setMeta(c, { ...stored, piSessionFile: current.piSessionFile });
    if (c.meta.piSessionFile !== stored.piSessionFile) await store.putSession(c.meta);
    queueMicrotask(() => void broadcastSessions());
  } else {
    await store.putSession(current);
  }
  // The bridge may have gone away while storing; then a new one starts.
  await startChat(c);
  const sentTo = c.connection;
  if (sentTo.state === "down") return giveBack(c, [{ text, images }]);
  // A restart during storage writes must not drop the message. Permission
  // callbacks belong to their original controller, not the replacement port.
  const promptId = crypto.randomUUID();
  sentTo.unanswered.set(promptId, { text, images, accept: origin.state !== "down" && origin.port === sentTo.port ? accept : undefined });
  // The chat shows it once pi starts it (a `user` chunk).
  const request: Extract<BridgeRequest, { type: "prompt" }> = { type: "prompt", text, images, promptId };
  if (steer) request.steer = true;
  sentTo.sent++;
  postInParts(sentTo.port, request);
});

export function queueAction({ action, index, text }: QueueAction) {
  post(chat, { type: "queue_action", action, index, text });
}

export function abort() {
  if (chat?.connection.state === "connecting" || chat?.connection.state === "connected") chat.connection.browser?.cancel();
  post(chat, { type: "abort" });
}

export const compact = inOrder(() => {
  post(chat, { type: "compact" });
});

export const setModel = inOrder((provider: string, modelId: string) => {
  post(chat, { type: "set_model", provider, modelId });
});

export const setThinkingLevel = inOrder((level: ThinkingLevel) => {
  post(chat, { type: "set_thinking_level", level });
});

export async function attachPanel(p: chrome.runtime.Port) {
  panels.add(p);
  p.onDisconnect.addListener(() => panels.delete(p));
  await ready;
  postInParts(p, replay());
  postInParts(p, await sessionsUpdate());
  await handOver(p);
}
