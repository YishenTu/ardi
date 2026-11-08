import type { ChatChunk, ChatMessage, ImageAttachment, ModelState, PiCommand, QueueAction, QueuedMessage, ThinkingLevel } from "../chat";
import type { BridgeEvent, BridgeRequest } from "../bridge/protocol";
import { plainMentions } from "../mention";
import { restoreOf } from "../restore";
import { joinParts, postInParts } from "../parts";
import type { PanelUpdate, PiStatus, SessionMeta } from "../panel-protocol";
import { loadSettings } from "./settings";
import * as store from "./store";
import { target, type BrowserLink } from "./target";

// Owns the bridge connection (one pi process) and the current chat. Lives in
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

// The bridge connection: down, or a port (with the target's browser link
// for it, and what it hasn't answered) that is connecting until the bridge
// reports pi ready on the latest start or open.
type Connection =
  | { state: "down" }
  | { state: "connecting" | "connected"; port: chrome.runtime.Port; browser: BrowserLink | null; unanswered: Unanswered };
let connection: Connection = { state: "down" };
// Labels each start and open sent to the bridge. Session events labelled
// with an older one are about a chat the user left (a switch stops the run
// first, and its last output arrives late).
let epoch = 0;

// The chat on screen: the stored chat, pi's history for it (null while it
// loads), what pi sent since, and what waits in pi's queue. Replaced whole
// when the chat changes.
type Chat = { meta: SessionMeta; history: ChatMessage[] | null; live: ChatChunk[]; queue: QueuedMessage[] };
let chat: Chat;

// Text and images for the message box, held while no panel is open to take
// them, in chrome.storage.local: Chrome may stop the worker meanwhile.
const RETURNED = "returned";
type Returned = { text: string; images?: ImageAttachment[] }[];
// Kept across restarts and chat switches; the next `ready` refreshes it.
let model: ModelState = { models: [] };
let commands: PiCommand[] = [];
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
  return { meta, history: isDraft(meta) ? [] : null, live: [], queue: [] };
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

// Keeps the same chat, under new metadata (it was stored, or got its file).
function setMeta(meta: SessionMeta) {
  chat.meta = meta;
  void chrome.storage.local.set({ [CURRENT_CHAT]: meta.id });
}

function status(): PiStatus {
  return connection.state === "down" ? "disconnected" : connection.state;
}

function setConnection(next: Connection) {
  connection = next;
  broadcast({ kind: "status", status: status() });
}

function broadcast(update: PanelUpdate) {
  for (const p of panels) postInParts(p, update);
}

async function sessionsUpdate(): Promise<PanelUpdate> {
  return { kind: "sessions", sessions: await store.listSessions(), currentId: chat.meta.id };
}

async function broadcastSessions() {
  broadcast(await sessionsUpdate());
}

function pushLive(chunk: ChatChunk) {
  chat.live.push(chunk);
  broadcast({ kind: "live", chunk });
}

function replay(): PanelUpdate {
  return { kind: "replay", status: status(), session: chat.meta, history: chat.history, live: chat.live, queue: chat.queue, model, commands };
}

// A connection is going away: what it hasn't answered goes back.
function handBack(unanswered: Unanswered) {
  giveBack([...unanswered.values()]);
  unanswered.clear();
}

// To the message box of the open panels, or the next one to open.
let holding: Promise<void> = Promise.resolve();
function giveBack(messages: Returned) {
  const restore = restoreOf(messages);
  if (!restore) return;
  if (panels.size) return broadcast({ kind: "restore", ...restore });
  holding = holding.then(async () => {
    const { [RETURNED]: held = [] } = await chrome.storage.local.get(RETURNED);
    await chrome.storage.local.set({ [RETURNED]: [...(held as Returned), ...messages] });
  });
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

function post(request: BridgeRequest) {
  if (connection.state !== "down") postInParts(connection.port, request);
}

async function onBridgeEvent(event: Exclude<BridgeEvent, { type: "browser_request" | "browser_cancel" }>) {
  if ("epoch" in event && event.epoch !== epoch) return;
  switch (event.type) {
    case "prompt_result": {
      if (connection.state === "down") break;
      const sent = connection.unanswered.get(event.promptId);
      connection.unanswered.delete(event.promptId);
      if (event.started) sent?.accept?.();
      break;
    }
    case "ready": {
      // The bridge reports the session pi is on; for a new chat that's the
      // first time Ardi learns its file.
      const { meta } = chat;
      if (event.sessionFile !== meta.piSessionFile) {
        meta.piSessionFile = event.sessionFile;
        if (!isDraft(meta)) await store.putSession(meta);
      }
      // History is everything pi saved before this start or switch.
      chat.history = event.history;
      model = event.model;
      commands = event.commands;
      if (connection.state === "connecting") setConnection({ ...connection, state: "connected" });
      broadcast(replay());
      break;
    }
    case "history":
      // Only until pi's own `ready`.
      if (chat.history) break;
      chat.history = event.history;
      broadcast(replay());
      break;
    case "model":
      model = event.model;
      broadcast({ kind: "model", model });
      break;
    case "chunk":
      pushLive(event.chunk);
      break;
    case "queue":
      chat.queue = event.queue;
      broadcast({ kind: "queue", queue: chat.queue });
      break;
    case "restore":
      giveBack([event]);
      break;
    case "fatal":
      pushLive({ type: "notice", content: event.message, level: "error" });
      if (connection.state !== "down") handBack(connection.unanswered);
      break;
    case "pi_check":
      // Only sent to settings' own one-shot port (settings.ts).
      break;
  }
}

// Connects and sends `start` in one go once settings are read, so a caller
// that awaited it finds the connection up (or down for good) with `start`
// already sent ahead of anything it posts. Calls meanwhile share it.
let starting: Promise<void> | null = null;
export function start(): Promise<void> {
  starting ??= connect().finally(() => (starting = null));
  return starting;
}

async function connect() {
  await ready;
  if (connection.state !== "down") return;
  const { piPath } = await loadSettings();
  // What pi sent belongs to the pi that's gone.
  chat = { ...chat, live: [], queue: [] };
  const p = chrome.runtime.connectNative(target().nativeHost);
  const unanswered: Unanswered = new Map();
  const isCurrent = () => connection.state !== "down" && connection.port === p;
  // Replies go only to the port that asked, not a replacement.
  const link = target().connectBrowser?.((reply) => { if (isCurrent()) postInParts(p, reply); }) ?? null;
  p.onMessage.addListener(joinParts<BridgeEvent>((event) => {
    if (!isCurrent()) return;
    if (event.type === "browser_request" || event.type === "browser_cancel") return link?.receive(event);
    void onBridgeEvent(event);
  }));
  p.onDisconnect.addListener(() => {
    void link?.dispose();
    const err = chrome.runtime.lastError?.message;
    if (err) console.warn("pi bridge disconnected:", err);
    handBack(unanswered);
    if (isCurrent()) setConnection({ state: "down" });
  });
  setConnection({ state: "connecting", port: p, browser: link, unanswered });
  post({ type: "start", sessionFile: chat.meta.piSessionFile, piPath: piPath || undefined, epoch: ++epoch });
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

// Restarts the pi process; pi resumes the same session. Also applies
// changed settings.
export async function restart() {
  const old = connection;
  setConnection({ state: "down" });
  if (old.state !== "down") {
    handBack(old.unanswered);
    await old.browser?.dispose();
    old.port.disconnect();
  }
  await start();
}

// pi keeps running and switches session in place; `ready` brings the history.
async function switchTo(next: SessionMeta) {
  chat = opened(next);
  void chrome.storage.local.set({ [CURRENT_CHAT]: next.id });
  broadcast(replay());
  // Labelled as it's sent, with nothing awaited in between: what pi still
  // sends about the chat being left carries an older label, and a `start`
  // sent meanwhile can't get a newer one.
  const opening = connection.state !== "down" ? post({ type: "open", sessionFile: next.piSessionFile, epoch: ++epoch }) : start();
  await broadcastSessions();
  await opening;
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
  if (id !== chat.meta.id) return broadcastSessions();
  const [latest] = await store.listSessions();
  await switchTo(latest ?? draft());
});

export const prompt = inOrder(async (text: string, images?: ImageAttachment[], steer = false) => {
  await start();
  const origin = connection;
  const accept = origin.state !== "down" ? origin.browser?.preparePrompt() : undefined;
  const current = chat.meta;
  current.updatedAt = Date.now();
  if (isDraft(current)) {
    // First message: the chat becomes real and joins the list.
    const { id: _, ...meta } = current;
    const stored = await store.addSession({ ...meta, title: plainMentions(text).slice(0, TITLE_LEN) });
    // `ready` can name the session file while the chat is being stored.
    setMeta({ ...stored, piSessionFile: current.piSessionFile });
    if (chat.meta.piSessionFile !== stored.piSessionFile) await store.putSession(chat.meta);
    queueMicrotask(() => void broadcastSessions());
  } else {
    await store.putSession(current);
  }
  // The bridge may have gone away while storing; then a new one starts.
  await start();
  const sentTo = connection;
  if (sentTo.state === "down") return giveBack([{ text, images }]);
  // A restart during storage writes must not drop the message. Permission
  // callbacks belong to their original controller, not the replacement port.
  const promptId = crypto.randomUUID();
  sentTo.unanswered.set(promptId, { text, images, accept: origin.state !== "down" && origin.port === sentTo.port ? accept : undefined });
  // The chat shows it once pi starts it (a `user` chunk).
  const request: Extract<BridgeRequest, { type: "prompt" }> = { type: "prompt", text, images, promptId };
  if (steer) request.steer = true;
  postInParts(sentTo.port, request);
});

export function queueAction({ action, index, text }: QueueAction) {
  post({ type: "queue_action", action, index, text });
}

export function abort() {
  if (connection.state !== "down") connection.browser?.cancel();
  post({ type: "abort" });
}

export const compact = inOrder(() => {
  post({ type: "compact" });
});

export const setModel = inOrder((provider: string, modelId: string) => {
  post({ type: "set_model", provider, modelId });
});

export const setThinkingLevel = inOrder((level: ThinkingLevel) => {
  post({ type: "set_thinking_level", level });
});

export async function attachPanel(p: chrome.runtime.Port) {
  panels.add(p);
  p.onDisconnect.addListener(() => panels.delete(p));
  await ready;
  postInParts(p, replay());
  postInParts(p, await sessionsUpdate());
  await handOver(p);
}
