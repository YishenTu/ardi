import type { ChatChunk, ChatMessage, ImageAttachment, ModelState, PiCommand, QueueAction, QueuedMessage, ThinkingLevel } from "../chat";
import type { BridgeEvent, BridgeRequest, BrowserReply, ScheduleReply } from "../bridge/protocol";
import { plainMentions } from "../mention";
import { restoreOf } from "../restore";
import { joinParts, postInParts } from "../parts";
import type { PanelUpdate, PiStatus, SessionMeta } from "../panel-protocol";
import { runMessage, type Scheduled } from "../schedule";
import * as held from "./held";
import * as schedules from "./schedules";
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

// A chat's bridge connection, one phase at a time:
// - down: no bridge.
// - starting: settings are being read before the bridge opens; `started`
//   settles once it's open with `start` sent (or the start was given up).
// - connecting/connected: a port, until and after the bridge reports pi
//   ready, with the target's browser link for it, what it hasn't answered,
//   and what its pi is doing: a run (for the chat list) and its queue.
//   `sent` counts requests posted on it; the bridge's latest `busy` report
//   gives `acked` (how many it had received) and `reportedBusy`. It has
//   work while it reports busy or hasn't yet reported on everything sent.
type Live = {
  state: "connecting" | "connected";
  port: chrome.runtime.Port;
  browser: BrowserLink | null;
  unanswered: Unanswered;
  running: boolean;
  queue: QueuedMessage[];
  sent: number;
  acked: number;
  reportedBusy: boolean;
};
type Connection = { state: "down" } | { state: "starting"; started: Promise<void> } | Live;

// A chat and what its pi reported: the stored chat, pi's history for it
// (null while it loads), and what pi sent since.
type Chat = {
  meta: SessionMeta;
  history: ChatMessage[] | null;
  live: ChatChunk[];
  model: ModelState;
  commands: PiCommand[];
  connection: Connection;
};

// The chat on screen.
let chat: Chat;
// Chats off screen that pi still works on. Leaving an idle chat stops its pi;
// a chat that finishes off screen stops it then.
const away = new Set<Chat>();

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
    meta, history: isDraft(meta) ? [] : null, live: [], model: lastModel, commands: lastCommands, connection: { state: "down" },
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

// `c`'s bridge while it's open.
function live(c: Chat): Live | undefined {
  const conn = c.connection;
  return conn.state === "connecting" || conn.state === "connected" ? conn : undefined;
}

function status(c: Chat): PiStatus {
  const { state } = c.connection;
  return state === "down" ? "disconnected" : state === "starting" ? "connecting" : state;
}

function setConnection(c: Chat, next: Connection) {
  c.connection = next;
  toScreen(c, { kind: "status", status: status(c) });
}

// Posts to panel `p`; false if it's gone. Chrome reports a closed panel
// only later, and posting to it meanwhile throws: it's dropped instead, so
// it can't interrupt what the background is doing.
function toPanel(p: chrome.runtime.Port, update: PanelUpdate): boolean {
  try {
    postInParts(p, update);
    return true;
  } catch {
    panels.delete(p);
    return false;
  }
}

function broadcast(update: PanelUpdate) {
  for (const p of panels) toPanel(p, update);
}

// Shown only while `c` is on screen; a chat off screen is replayed when the
// user comes back.
function toScreen(c: Chat, update: PanelUpdate) {
  if (c === chat) broadcast(update);
}

async function sessionsUpdate(): Promise<PanelUpdate> {
  const running = [chat, ...away].filter((c) => live(c)?.running && !isDraft(c.meta)).map((c) => c.meta.id);
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
  return { kind: "replay", status: status(chat), session: chat.meta, history: chat.history, live: chat.live, queue: live(chat)?.queue ?? [], model: chat.model, commands: chat.commands };
}

// `c`'s bridge has work left. Only the bridge knows what it has in hand (a
// run, a queue, input on its way to pi, a compaction), so nothing here
// guesses from pi's events; what it hasn't reported on yet counts as work.
function busy(c: Chat): boolean {
  const conn = live(c);
  return !!conn && (conn.reportedBusy || conn.acked < conn.sent);
}

// A chat off screen that pi is done with stops its pi and is dropped.
function settle(c: Chat) {
  if (c === chat || busy(c)) return;
  stop(c);
  away.delete(c);
}

// Shuts `c`'s bridge down, dropping what it hasn't answered.
function stop(c: Chat) {
  void closeConnection(c, "drop");
}

// Takes `c`'s bridge down: nothing runs or waits any more (its run ends and
// its queue empties on screen too), what it hasn't answered goes back to the
// message box or is dropped, and its browser link is disposed (the returned
// promise).
function closeConnection(c: Chat, unanswered: "hand back" | "drop"): Promise<void> {
  const old = live(c);
  setConnection(c, { state: "down" });
  if (!old) return Promise.resolve();
  // Ended, not interrupted: that's only for the user's Stop, and pi's history
  // doesn't mark it either.
  if (old.running) {
    pushLive(c, { type: "run_end", at: Date.now() });
    void broadcastSessions();
  }
  if (old.queue.length) toScreen(c, { kind: "queue", queue: [] });
  if (unanswered === "hand back") giveBack(c, [...old.unanswered.values()]);
  old.unanswered.clear();
  const disposed = old.browser?.dispose() ?? Promise.resolve();
  old.port.disconnect();
  return disposed;
}

// To the message box of the open panels if `c` is on screen; else held
// for `c` until a panel shows it.
function giveBack(c: Chat, messages: held.Returned) {
  if (!messages.length) return;
  const restore = restoreOf(messages);
  if (c === chat && panels.size && restore) return broadcast({ kind: "restore", ...restore });
  held.hold(c.meta.id, messages);
}

// Hands what's held for the chat on screen (when its turn comes) to panel
// `to`, or to every open panel; it stays held if no panel took it.
function handOver(to?: chrome.runtime.Port): Promise<void> {
  return held.handOver(() => chat.meta.id, (restore) => {
    const ports = to ? [to].filter((p) => panels.has(p)) : [...panels];
    return ports.filter((p) => toPanel(p, { kind: "restore", ...restore })).length > 0;
  });
}

// Requests the bridge counts (`sent`): all but replies to pi's tools.
type Counted = Exclude<BridgeRequest, BrowserReply | ScheduleReply>;

// Every counted request goes through here.
function post(conn: Live | undefined, request: Counted) {
  if (!conn) return;
  conn.sent++;
  postInParts(conn.port, request);
}

function setRunning(conn: Live, running: boolean) {
  if (conn.running === running) return;
  conn.running = running;
  void broadcastSessions();
}

// Events from `conn`, the bridge `c` has open.
async function onBridgeEvent(c: Chat, conn: Live, event: Exclude<BridgeEvent, { type: "browser_request" | "browser_cancel" }>) {
  switch (event.type) {
    case "prompt_result": {
      const sent = conn.unanswered.get(event.promptId);
      conn.unanswered.delete(event.promptId);
      if (event.started) sent?.accept?.();
      break;
    }
    case "ready": {
      // The bridge reports the session pi is on; for a new chat that's the
      // first time Ardi learns its file.
      const { meta } = c;
      const moved = event.sessionFile !== meta.piSessionFile;
      meta.piSessionFile = event.sessionFile;
      // History is everything pi saved before it started.
      c.history = event.history;
      c.model = lastModel = event.model;
      c.commands = lastCommands = event.commands;
      conn.state = "connected";
      toScreen(c, replay());
      // Stored last, so nothing above runs after this connection was replaced.
      if (moved && !isDraft(meta)) await store.putSession(meta);
      break;
    }
    case "busy":
      conn.reportedBusy = event.busy;
      conn.acked = event.requests;
      settle(c);
      break;
    case "history":
      // Only until this pi's own `ready`; it replaces what an earlier pi read.
      if (conn.state === "connected") break;
      c.history = event.history;
      toScreen(c, replay());
      break;
    case "model":
      c.model = lastModel = event.model;
      toScreen(c, { kind: "model", model: c.model });
      break;
    case "chunk":
      pushLive(c, event.chunk);
      if (event.chunk.type === "run_start") setRunning(conn, true);
      if (event.chunk.type === "run_end") setRunning(conn, false);
      break;
    case "queue":
      conn.queue = event.queue;
      toScreen(c, { kind: "queue", queue: conn.queue });
      break;
    case "restore":
      giveBack(c, [event]);
      break;
    case "fatal":
      pushLive(c, { type: "notice", content: event.message, level: "error" });
      giveBack(c, [...conn.unanswered.values()]);
      conn.unanswered.clear();
      break;
    case "schedule_request": {
      const reply = await schedules.answerTool(event.request, { chatId: c.meta.id, model: c.model }).then(
        (result) => ({ result }),
        (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }),
      );
      // A reply answers pi's tool, not the user: not counted in `sent`.
      if (live(c) === conn) postInParts(conn.port, { type: "schedule_reply", id: event.id, ...reply });
      break;
    }
    case "pi_check":
    case "tabs":
      // Only sent to the one-shot ports of ask-bridge.ts.
      break;
  }
}

// Opens `c`'s bridge and sends `start` in one go once settings are read, so
// a caller that awaited it finds the bridge open (or down for good) with
// `start` already sent ahead of anything it posts. Calls meanwhile share it.
function startChat(c: Chat): Promise<void> {
  if (c.connection.state === "starting") return c.connection.started;
  if (c.connection.state !== "down") return Promise.resolve();
  const starting: Extract<Connection, { state: "starting" }> = { state: "starting", started: Promise.resolve() };
  setConnection(c, starting);
  starting.started = connect(c, starting);
  return starting.started;
}

// Starts pi for the chat on screen.
export async function start(): Promise<void> {
  await ready;
  await startChat(chat);
}

async function connect(c: Chat, starting: Connection) {
  const { piPath } = await loadSettings();
  // Restarted, stopped or left while settings were read.
  if (c.connection !== starting) return;
  // What pi sent belongs to the pi that's gone.
  c.live = [];
  const p = chrome.runtime.connectNative(target().nativeHost);
  const isCurrent = () => c.connection === conn;
  // Replies go only to the port that asked, not a replacement.
  const link = target().connectBrowser?.((reply) => { if (isCurrent()) postInParts(p, reply); }) ?? null;
  const conn: Live = {
    state: "connecting", port: p, browser: link, unanswered: new Map(), running: false, queue: [], sent: 0, acked: 0, reportedBusy: false,
  };
  p.onMessage.addListener(joinParts<BridgeEvent>((event) => {
    if (!isCurrent()) return;
    if (event.type === "browser_request" || event.type === "browser_cancel") return link?.receive(event);
    void onBridgeEvent(c, conn, event);
  }));
  p.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError?.message;
    if (err) console.warn("pi bridge disconnected:", err);
    // Replaced or stopped already: that took care of what it hadn't answered.
    if (!isCurrent()) return void link?.dispose();
    void closeConnection(c, "hand back");
    settle(c);
  });
  setConnection(c, conn);
  post(conn, { type: "start", sessionFile: c.meta.piSessionFile, piPath: piPath || undefined });
}

// What the panel and settings ask for runs one request at a time, in the
// order asked, once the worker knows which chat is open: a message still
// being stored must not land in a chat the user switched to meanwhile, nor
// be passed by a new chat. Stop and restart don't wait: a message being
// stored when pi restarts goes to the new pi.
let queue: Promise<unknown> = Promise.resolve();

function inOrder<A extends unknown[]>(run: (...args: A) => unknown): (...args: A) => Promise<void> {
  return (...args) => {
    // `ready` on every call: one that failed fails each request, not just the first.
    const done = queue.then(async () => {
      await ready;
      await run(...args);
    });
    queue = done.catch((error: unknown) => console.error("request failed:", error));
    return done;
  };
}

// Restarts the chat on screen's pi; pi resumes the same session. Also
// applies changed settings.
export async function restart() {
  await ready;
  const c = chat;
  await closeConnection(c, "hand back");
  // Left while its browser link closed: the switch already stopped it.
  if (c === chat) await startChat(c);
}

// A panel shows `c`: what a scheduled run did there is no longer unread.
async function seen(c: Chat) {
  c.meta.unread = false;
  await store.putSession(c.meta);
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
  if (!stopLeft && busy(left)) away.add(left);
  else stop(left);
  void handOver();
  if (chat.meta.unread) await seen(chat);
  await broadcastSessions();
  await startChat(chat);
}

export const newSession = inOrder(async () => {
  if (!isDraft(chat.meta)) await switchTo(draft());
});

export const switchSession = inOrder(async (id: number) => {
  const meta = await store.getSession(id);
  if (meta && meta.id !== chat.meta.id) await switchTo(meta);
});

export const deleteSession = inOrder(async (id: number) => {
  await store.deleteSession(id);
  held.drop(id);
  await schedules.dropCheckBack(id);
  for (const c of away) {
    if (c.meta.id !== id) continue;
    stop(c);
    away.delete(c);
  }
  if (id !== chat.meta.id) return broadcastSessions();
  const [latest] = await store.listSessions();
  await switchTo(latest ?? draft(), { stopLeft: true });
});

export const prompt = inOrder(async (text: string, images?: ImageAttachment[], steer?: boolean) => {
  // The chat it was sent from, even if the user moves on meanwhile.
  await send(chat, text, images, steer);
});

// Runs what came due: a check-back prompts its chat; a job, a new chat named
// after it, on the job's model and effort. A chat off screen runs
// in the background like one the user left, and is marked unread.
export const runJob = inOrder(async (run: Scheduled) => {
  // Storage first: once the chat is picked, nothing may wait until the prompt
  // is sent, or its bridge could report idle and be stopped meanwhile.
  const now = Date.now();
  let meta: SessionMeta | undefined;
  if (run.kind === "job") {
    meta = await store.addSession({ title: run.title.slice(0, TITLE_LEN), createdAt: now, updatedAt: now, unread: true });
  } else {
    meta = await store.getSession(run.chatId);
    // The chat was deleted.
    if (!meta) return;
    meta.updatedAt = now;
    if (meta.id !== chat.meta.id) meta.unread = true;
    await store.putSession(meta);
  }
  const c = meta.id === chat.meta.id ? chat : ([...away].find((a) => a.meta.id === meta.id) ?? opened(meta));
  if (c !== chat) {
    away.add(c);
    c.meta.updatedAt = now;
    c.meta.unread = true;
  }
  // From here to the prompt nothing waits: a bridge that reports idle in
  // between would be stopped as a chat off screen with nothing to do.
  await startChat(c);
  const conn = live(c);
  // pi couldn't start; the run is skipped.
  if (!conn) return;
  if (run.kind === "job") {
    if (run.model) post(conn, { type: "set_model", provider: run.model.provider, modelId: run.model.id });
    if (run.thinkingLevel) post(conn, { type: "set_thinking_level", level: run.thinkingLevel });
  }
  deliver(conn, runMessage(run), undefined, false, conn.browser?.preparePrompt());
  await broadcastSessions();
});

// Sends a message to `c`'s pi, starting it if needed. A draft becomes a
// stored chat named after its first message.
async function send(c: Chat, text: string, images?: ImageAttachment[], steer = false) {
  await startChat(c);
  const origin = live(c);
  const accept = origin?.browser?.preparePrompt();
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
  const sentTo = live(c);
  if (!sentTo) return giveBack(c, [{ text, images }]);
  // A restart during storage writes must not drop the message. Permission
  // callbacks belong to their original controller, not the replacement port.
  deliver(sentTo, text, images, steer, origin?.port === sentTo.port ? accept : undefined);
}

// Posts a prompt to an open bridge; it waits in `unanswered` until pi answers.
function deliver(conn: Live, text: string, images: ImageAttachment[] | undefined, steer: boolean, accept?: () => void) {
  const promptId = crypto.randomUUID();
  conn.unanswered.set(promptId, { text, images, accept });
  // The chat shows it once pi starts it (a `user` chunk).
  const request: Extract<BridgeRequest, { type: "prompt" }> = { type: "prompt", text, images, promptId };
  if (steer) request.steer = true;
  post(conn, request);
}

// Queue edits and Stop don't wait their turn, so they can come before the
// worker knows which chat is open; then there's no bridge to tell.
export function queueAction({ action, index, text }: QueueAction) {
  if (chat) post(live(chat), { type: "queue_action", action, index, text });
}

export function abort() {
  const conn = chat && live(chat);
  conn?.browser?.cancel();
  post(conn, { type: "abort" });
}

export const compact = inOrder(() => {
  post(live(chat), { type: "compact" });
});

export const setModel = inOrder((provider: string, modelId: string) => {
  post(live(chat), { type: "set_model", provider, modelId });
});

export const setThinkingLevel = inOrder((level: ThinkingLevel) => {
  post(live(chat), { type: "set_thinking_level", level });
});

export async function attachPanel(p: chrome.runtime.Port) {
  panels.add(p);
  p.onDisconnect.addListener(() => panels.delete(p));
  await ready;
  // Only waits when there's something to clear, so a panel's replay isn't held up.
  if (chat.meta.unread) await seen(chat);
  postInParts(p, replay());
  postInParts(p, await sessionsUpdate());
  await handOver(p);
}
