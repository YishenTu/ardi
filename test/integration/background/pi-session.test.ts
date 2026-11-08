// The background's chat and pi connection, driven like the panel and the
// bridge would. The module keeps its chat and connection for the worker's
// lifetime, so each test imports a fresh copy and starts from an empty list.
import "../../support/indexeddb";

import { IDBIndex, IDBObjectStore } from "fake-indexeddb";
import { beforeEach, describe, expect, spyOn, test } from "bun:test";

import { CHROME_MAX_MESSAGE_BYTES, chromeFake, FakePort } from "../../support/chrome";
import { joinParts } from "../../../src/parts";
import { waitFor } from "../../support/wait";
import type { BridgeEvent } from "../../../src/bridge/protocol";
import type { ChatChunk, ChatMessage } from "../../../src/chat";
import type { PanelUpdate } from "../../../src/panel-protocol";
import * as store from "../../../src/background/store";
import { setTarget } from "../../../src/background/target";

type Background = typeof import("../../../src/background/pi-session");

let pi: Background;
let panel: FakePort;
let copies = 0;

beforeEach(async () => {
  setTarget({ nativeHost: "com.ardi.test" });
  for (const chat of await store.listSessions()) await store.deleteSession(chat.id);
  await restartWorker();
});

// A fresh copy of the module, like the worker after a browser restart or an
// extension reload; storage and the chat list stay.
async function restartWorker() {
  pi = (await import(`../../../src/background/pi-session.ts?copy=${copies++}`)) as Background;
  panel = await attach();
}

async function attach(): Promise<FakePort> {
  const port = new FakePort("panel");
  await pi.attachPanel(port.port);
  return port;
}

const updates = (port = panel) => port.sent as PanelUpdate[];
const last = <K extends PanelUpdate["kind"]>(kind: K, port = panel) =>
  updates(port).findLast((u): u is Extract<PanelUpdate, { kind: K }> => u.kind === kind);
const bridge = () => chromeFake.nativePorts.at(-1)!;
const fromBridge = (event: BridgeEvent) => bridge().receive(event);
// The epoch of the latest start or open sent to the bridge, which labels
// the bridge's events about the session it put pi on.
const latest = () => (bridge().sent as { type: string; epoch?: number }[]).findLast((r) => r.type === "start" || r.type === "open")!.epoch!;
const chunk = (chunk: ChatChunk, epoch = latest()) => fromBridge({ type: "chunk", chunk, epoch });
const ready = (sessionFile?: string, history: ChatMessage[] = [], epoch = latest()) =>
  fromBridge({ type: "ready", sessionFile, history, model: { models: [] }, commands: [], epoch });
const liveChunks = () => last("replay")!.live;

const SESSION_FILE = "/sessions/kyoto.jsonl";
const HISTORY: ChatMessage[] = [{ role: "user", id: "u1", content: "earlier", timestamp: 1 }];

// A stored chat on `file`, with pi up on it.
async function storedChat(file = SESSION_FILE) {
  await pi.prompt("earlier");
  ready(file, HISTORY);
  await waitFor(async () => expect((await store.listSessions())[0]?.piSessionFile).toBe(file));
  return (await store.listSessions())[0];
}

describe("background pi session", () => {
  test("a panel that attaches gets the current chat replayed", () => {
    expect(updates()[0]).toMatchObject({ kind: "replay", status: "disconnected", session: { id: 0, title: "" }, history: [], live: [] });
    expect(updates()[1]).toEqual({ kind: "sessions", sessions: [], currentId: 0 });
  });

  test("the first message starts pi and turns the draft into a stored chat named after it, tab mentions as @title", async () => {
    const text = "Plan a trip like [@Kyoto in 3 days](https://example.com/kyoto), with temples, food markets and a day in Nara";
    await pi.prompt(text);
    expect(bridge().sent).toEqual([
      { type: "start", sessionFile: undefined, piPath: undefined, epoch: expect.any(Number) },
      { type: "prompt", text, promptId: expect.any(String) },
    ]);
    // The chat shows it once pi starts it.
    expect(last("live")).toBeUndefined();
    const [chat] = await store.listSessions();
    expect(chat.title).toBe("Plan a trip like @Kyoto in 3 days, with temples, food market");
    await waitFor(() => expect(last("sessions")?.sessions).toHaveLength(1));
  });

  test("images sent with a message go to pi, and show in the chat once pi starts it", async () => {
    const images = [{ data: "aGk=", mimeType: "image/png" }];
    await pi.prompt("what's this?", images);
    expect(bridge().sent.at(-1)).toEqual({ type: "prompt", text: "what's this?", images, promptId: expect.any(String) });
    ready(SESSION_FILE);
    chunk({ type: "user", text: "what's this?", images, at: 1 });
    expect(last("live")).toEqual({ kind: "live", chunk: { type: "user", text: "what's this?", images, at: 1 } });
  });

  test("an image bigger than one Chrome message still reaches pi and a reopened panel", async () => {
    const data = "A".repeat(CHROME_MAX_MESSAGE_BYTES + 1024);
    await pi.prompt("look", [{ data, mimeType: "image/png" }]);
    const toBridge: unknown[] = [];
    bridge().sent.forEach(joinParts((request) => toBridge.push(request)));
    expect(toBridge.at(-1)).toMatchObject({ type: "prompt", text: "look", images: [{ mimeType: "image/png" }] });
    expect((toBridge.at(-1) as { images: { data: string }[] }).images[0].data).toHaveLength(data.length);
    ready(SESSION_FILE);
    chunk({ type: "user", text: "look", images: [{ data, mimeType: "image/png" }], at: 1 });

    const reopened = await attach();
    const toPanel: PanelUpdate[] = [];
    reopened.sent.forEach(joinParts<PanelUpdate>((update) => toPanel.push(update)));
    const replay = toPanel.find((u) => u.kind === "replay");
    expect(replay?.live[0]).toMatchObject({ type: "user", text: "look" });
    expect(toPanel.at(-1)?.kind).toBe("sessions");
  });

  test("starting twice at once opens one bridge", async () => {
    await Promise.all([pi.start(), pi.start()]);
    expect(chromeFake.nativePorts).toHaveLength(1);
  });

  test("ready saves pi's session file on the chat and replays history", async () => {
    await pi.prompt("earlier");
    fromBridge({ type: "ready", sessionFile: SESSION_FILE, history: HISTORY, model: { models: [] }, commands: [{ name: "skill:demo" }], epoch: latest() });
    await waitFor(async () => expect((await store.listSessions())[0].piSessionFile).toBe(SESSION_FILE));
    expect(last("replay")).toMatchObject({ status: "connected", history: HISTORY, commands: [{ name: "skill:demo" }], live: [] });
  });

  test("a session file pi reports while the first message is being stored is kept", async () => {
    // The bridge answers `start` while the new chat is being written.
    // oxlint-disable-next-line typescript/unbound-method -- called below with the store as `this`
    const { add } = IDBObjectStore.prototype;
    IDBObjectStore.prototype.add = function (...args) {
      ready(SESSION_FILE);
      return add.apply(this, args);
    };
    try {
      await pi.prompt("hello");
    } finally {
      IDBObjectStore.prototype.add = add;
    }
    await waitFor(async () => expect((await store.listSessions())[0].piSessionFile).toBe(SESSION_FILE));
  });

  test("chunks from pi reach the panel, including ones the bridge split into parts", async () => {
    await storedChat();
    chunk({ type: "text", content: "Day 1" });
    expect(last("live")).toEqual({ kind: "live", chunk: { type: "text", content: "Day 1" } });

    const big = JSON.stringify({ type: "chunk", chunk: { type: "text", content: "x".repeat(1000) } });
    bridge().receive({ type: "part", data: big.slice(0, 400), last: false });
    bridge().receive({ type: "part", data: big.slice(400), last: true });
    expect(last("live")).toEqual({ kind: "live", chunk: { type: "text", content: "x".repeat(1000) } });
  });

  test("closing the panel leaves pi running, and a new panel gets what happened meanwhile", async () => {
    await storedChat();
    panel.close();
    chunk({ type: "text", content: "Day 1" });
    expect(bridge().disconnected).toBe(false);
    const next = await attach();
    expect(last("replay", next)?.live).toContainEqual({ type: "text", content: "Day 1" });
  });

  test("a fatal bridge error shows as an error notice", async () => {
    await pi.start();
    fromBridge({ type: "fatal", message: "pi exited (code 1)" });
    expect(last("live")?.chunk).toEqual({ type: "notice", content: "pi exited (code 1)", level: "error" });
  });

  test("restart starts pi again on the same chat, with the pi path from Settings", async () => {
    await storedChat();
    chromeFake.storage.set("settings", { piPath: "/opt/pi" });
    const old = bridge();
    await pi.restart();
    expect(old.disconnected).toBe(true);
    expect(bridge()).not.toBe(old);
    expect(bridge().sent).toEqual([{ type: "start", sessionFile: SESSION_FILE, piPath: "/opt/pi", epoch: expect.any(Number) }]);
    expect(last("status")).toEqual({ kind: "status", status: "connecting" });
  });

  test("a new chat moves the running pi with open and stays a draft until its first message", async () => {
    await storedChat();
    await pi.newSession();
    expect(bridge().sent.at(-1)).toEqual({ type: "open", sessionFile: undefined, epoch: expect.any(Number) });
    expect(last("replay")).toMatchObject({ session: { id: 0 }, history: [], live: [] });

    ready("/sessions/new.jsonl");
    await waitFor(() => expect(last("replay")?.status).toBe("connected"));
    expect(await store.listSessions()).toHaveLength(1);
  });

  test("a new chat asked for while the first message is still being stored opens after it", async () => {
    await Promise.all([pi.prompt("first"), pi.newSession()]);
    expect((await store.listSessions()).map((chat) => chat.title)).toEqual(["first"]);
    expect(bridge().sent.map((request: { type: string }) => request.type)).toEqual(["start", "prompt", "open"]);
    expect(last("replay")).toMatchObject({ session: { id: 0 }, live: [] });
  });

  test("a message sent just before a chat switch stays in the chat it was sent from", async () => {
    await storedChat();
    await Promise.all([pi.prompt("again"), pi.newSession()]);
    expect(bridge().sent.map((request: { type: string }) => request.type).slice(-2)).toEqual(["prompt", "open"]);
    expect(last("replay")).toMatchObject({ session: { id: 0 }, live: [] });
  });

  test("stop isn't held up behind a message still being stored", async () => {
    await storedChat();
    const sending = pi.prompt("again");
    pi.abort();
    expect(bridge().sent.at(-1)).toEqual({ type: "abort" });
    await sending;
  });

  test("switching back to a stored chat opens its session file", async () => {
    const chat = await storedChat();
    await pi.newSession();
    ready("/sessions/new.jsonl");
    await pi.switchSession(chat.id);
    expect(bridge().sent.at(-1)).toEqual({ type: "open", sessionFile: SESSION_FILE, epoch: expect.any(Number) });
    expect(last("replay")?.session.id).toBe(chat.id);
  });

  test("what a stopped run still sends while pi switches chats stays out of the next chat", async () => {
    await storedChat();
    chunk({ type: "run_start", at: 1 });
    const left = latest();
    await pi.newSession();
    // pi stops the run before switching; its last output arrives late.
    chunk({ type: "text", content: "the rest of Kyoto" }, left);
    chunk({ type: "run_end", at: 2, interrupted: true }, left);
    ready("/sessions/new.jsonl");
    await waitFor(() => expect(last("replay")?.status).toBe("connected"));
    expect(liveChunks()).toEqual([]);

    chunk({ type: "text", content: "Hi" });
    expect(last("live")?.chunk).toEqual({ type: "text", content: "Hi" });
  });

  test("a ready that answers an earlier start or open isn't applied to the chat the user moved to", async () => {
    await storedChat();
    await pi.restart();
    const restarted = latest();
    await pi.newSession();
    // The restart's `ready`, for the chat the user just left.
    ready(SESSION_FILE, HISTORY, restarted);
    await Promise.resolve();
    expect(last("replay")).toMatchObject({ status: "connecting", session: { id: 0 }, history: [] });
    expect(last("replay")?.session.piSessionFile).toBeUndefined();

    ready("/sessions/new.jsonl");
    await waitFor(() => expect(last("replay")).toMatchObject({ status: "connected", session: { piSessionFile: "/sessions/new.jsonl" } }));
  });

  test("a restarted worker comes back to the chat that was open, even a new one with no messages yet", async () => {
    const chat = await storedChat();
    await restartWorker();
    expect(last("replay")?.session.id).toBe(chat.id);

    await pi.newSession();
    await restartWorker();
    expect(last("replay")?.session).toMatchObject({ id: 0, title: "" });
    expect(updates()[1]).toMatchObject({ kind: "sessions", currentId: 0 });
  });

  test("a saved chat shows its history as soon as the bridge reads it, before pi is up", async () => {
    const chat = await storedChat();
    await restartWorker();
    // Not loaded yet, rather than empty.
    expect(last("replay")).toMatchObject({ session: { id: chat.id }, history: null });
    await pi.start();
    // Read for an earlier start or open.
    fromBridge({ type: "history", sessionFile: "/sessions/other.jsonl", history: [], epoch: latest() - 1 });
    expect(last("replay")?.history).toBeNull();
    fromBridge({ type: "history", sessionFile: SESSION_FILE, history: HISTORY, epoch: latest() });
    expect(last("replay")).toMatchObject({ status: "connecting", history: HISTORY });
  });

  test("deleting the current chat moves to the next one, or a new draft", async () => {
    const chat = await storedChat();
    await pi.deleteSession(chat.id);
    expect(await store.listSessions()).toEqual([]);
    expect(bridge().sent.at(-1)).toEqual({ type: "open", sessionFile: undefined, epoch: expect.any(Number) });
    expect(last("replay")?.session.id).toBe(0);
    expect(last("sessions")).toEqual({ kind: "sessions", sessions: [], currentId: 0 });
  });

  test("when the bridge goes away, the panel sees pi as not running", async () => {
    await pi.start();
    bridge().close("Native host has exited.");
    expect(last("status")).toEqual({ kind: "status", status: "disconnected" });
  });

  test("a message pi never got goes back to the box when pi fails to start", async () => {
    await pi.prompt("plan my trip");
    fromBridge({ type: "fatal", message: "pi not found" });
    expect(last("restore")).toEqual({ kind: "restore", text: "plan my trip" });
  });

  test("a message handed back while the panel is closed waits for it, images included", async () => {
    const images = [{ data: "aGk=", mimeType: "image/png" }];
    await pi.prompt("", images);
    panel.close();
    fromBridge({ type: "fatal", message: "pi not found" });
    // Chrome may stop the worker before a panel opens again.
    await restartWorker();
    expect(last("restore")).toEqual({ kind: "restore", text: "", images });
    // Handed over once.
    expect(last("restore", await attach())).toBeUndefined();
  });

  test("a message sent while the bridge goes away goes to the next bridge", async () => {
    await pi.start();
    const old = bridge();
    // oxlint-disable-next-line typescript/unbound-method -- called below with the store as `this`
    const { add } = IDBObjectStore.prototype;
    IDBObjectStore.prototype.add = function (...args) {
      old.close("Native host has exited.");
      return add.apply(this, args);
    };
    try {
      await pi.prompt("still here");
    } finally {
      IDBObjectStore.prototype.add = add;
    }
    expect(bridge()).not.toBe(old);
    expect(bridge().sent).toContainEqual(expect.objectContaining({ type: "prompt", text: "still here" }));
  });

  test("held text survives a panel that closes before it's handed over", async () => {
    await pi.prompt("keep me");
    panel.close();
    fromBridge({ type: "fatal", message: "pi not found" });
    await waitFor(() => expect(chromeFake.storage.get("returned")).toEqual([{ text: "keep me" }]));
    // The panel closes while the held text is read from storage.
    const brief = new FakePort("panel");
    const read = chromeFake.storage.get.bind(chromeFake.storage);
    const reading = spyOn(chromeFake.storage, "get").mockImplementation((key: string) => {
      if (key === "returned") brief.close();
      return read(key);
    });
    try {
      await pi.attachPanel(brief.port).catch(() => undefined);
    } finally {
      reading.mockRestore();
    }
    expect(last("restore", await attach())).toEqual({ kind: "restore", text: "keep me" });
  });

  test("a chat switch while pi is still starting carries the newest label, so pi's answer counts", async () => {
    await storedChat();
    bridge().close("Native host has exited.");
    await Promise.all([pi.start(), pi.newSession()]);
    const labels = (bridge().sent as { type: string; epoch?: number }[]).filter((r) => r.type === "start" || r.type === "open").map((r) => r.epoch!);
    expect(labels).toEqual(labels.toSorted((a, b) => a - b));
    ready("/sessions/new.jsonl");
    await waitFor(() => expect(last("replay")).toMatchObject({ status: "connected", session: { id: 0, piSessionFile: "/sessions/new.jsonl" } }));
  });

  test("a message stored while pi restarts goes to the new pi and isn't also handed back", async () => {
    let disposed!: () => void;
    setTarget({ nativeHost: "com.ardi.test", connectBrowser: () => ({ receive() {}, preparePrompt: () => () => {}, cancel() {}, dispose: () => new Promise<void>((resolve) => (disposed = resolve)) }) });
    await storedChat();
    const sending = pi.prompt("again");
    // The old connection is still being torn down when the message is stored.
    const restarting = pi.restart();
    await sending;
    disposed();
    await restarting;
    expect(bridge().sent).toContainEqual(expect.objectContaining({ type: "prompt", text: "again" }));
    expect(last("restore")?.text ?? "").not.toContain("again");
  });

  test("a message pi answered isn't handed back when the bridge goes away", async () => {
    await storedChat();
    await pi.prompt("next");
    for (const request of bridge().sent) {
      if (request.type === "prompt") fromBridge({ type: "prompt_result", promptId: request.promptId, started: true });
    }
    bridge().close("Native host has exited.");
    expect(last("restore")).toBeUndefined();
  });

  test("a bubble from the chat being left doesn't land in the next one", async () => {
    await storedChat();
    const left = latest();
    // pi's last output arrives while the switch reads the chat list.
    // oxlint-disable-next-line typescript/unbound-method -- called below with the index as `this`
    const { getAll } = IDBIndex.prototype;
    IDBIndex.prototype.getAll = function (...args) {
      chunk({ type: "user", text: "from the old chat", at: 1 }, left);
      return getAll.apply(this, args);
    };
    try {
      await pi.newSession();
    } finally {
      IDBIndex.prototype.getAll = getAll;
    }
    ready("/sessions/new.jsonl");
    expect(last("replay")!.live).toEqual([]);
  });

  describe("while pi works", () => {
    async function working() {
      await storedChat();
      chunk({ type: "run_start", at: 1 });
    }

    test("Cmd+Enter asks pi to steer with the message", async () => {
      await working();
      await pi.prompt("later");
      await pi.prompt("now", undefined, true);
      expect(bridge().sent.slice(-2)).toEqual([
        { type: "prompt", text: "later", promptId: expect.any(String) },
        { type: "prompt", text: "now", promptId: expect.any(String), steer: true },
      ]);
    });

    test("the queue reaches the panel and a reopened one, and edits go to the bridge", async () => {
      await working();
      fromBridge({ type: "queue", queue: [{ text: "later", steer: false }], epoch: latest() });
      expect(last("queue")).toEqual({ kind: "queue", queue: [{ text: "later", steer: false }] });
      expect(last("replay", await attach())?.queue).toEqual([{ text: "later", steer: false }]);
      pi.queueAction({ action: "steer", index: 0, text: "later" });
      expect(bridge().sent.at(-1)).toEqual({ type: "queue_action", action: "steer", index: 0, text: "later" });
    });

    test("a queued message pi takes joins the chat; one a stop takes back goes to the message box", async () => {
      await working();
      chunk({ type: "user", text: "check promotions", at: 1 });
      expect(last("live")).toEqual({ kind: "live", chunk: { type: "user", text: "check promotions", at: 1 } });
      fromBridge({ type: "restore", text: "draft a reply" });
      expect(last("restore")).toEqual({ kind: "restore", text: "draft a reply" });
    });

    test("switching chats empties the queue", async () => {
      await working();
      fromBridge({ type: "queue", queue: [{ text: "later", steer: false }], epoch: latest() });
      await pi.newSession();
      expect(last("replay")?.queue).toEqual([]);
    });
  });
});
