// The background's chat and pi connection, driven like the panel and the
// bridge would. The module keeps its chat and connection for the worker's
// lifetime, so each test imports a fresh copy and starts from an empty list.
import "../../support/indexeddb";

import { IDBObjectStore } from "fake-indexeddb";
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
// Each chat with pi running has its own bridge; the latest one by default.
const bridge = () => chromeFake.nativePorts.at(-1)!;
const fromBridge = (event: BridgeEvent, to = bridge()) => to.receive(event);
const chunk = (chunk: ChatChunk, to = bridge()) => fromBridge({ type: "chunk", chunk }, to);
// The bridge reports pi working or input waiting, or nothing left to do,
// with how many requests it had received (all of them, unless given).
const received = (port: FakePort) => port.sent.filter((r: { type: string }) => r.type !== "browser_reply").length;
const busy = (value: boolean, to = bridge(), requests = received(to)) => fromBridge({ type: "busy", busy: value, requests }, to);
const ready = (sessionFile?: string, history: ChatMessage[] = [], to = bridge()) =>
  fromBridge({ type: "ready", sessionFile, history, model: { models: [] }, commands: [] }, to);
const liveChunks = () => last("replay")!.live;

const SESSION_FILE = "/sessions/kyoto.jsonl";
const HISTORY: ChatMessage[] = [{ role: "user", id: "u1", content: "earlier", timestamp: 1 }];

// A stored chat on `file`, with pi up on it and done with its first message.
async function storedChat(file = SESSION_FILE) {
  await pi.prompt("earlier");
  const sent = bridge().sent.findLast((r: { type: string }) => r.type === "prompt") as { promptId: string };
  fromBridge({ type: "prompt_result", promptId: sent.promptId, started: true });
  ready(file, HISTORY);
  chunk({ type: "run_start", at: 0 });
  chunk({ type: "run_end", at: 0 });
  busy(false);
  await waitFor(async () => expect((await store.listSessions())[0]?.piSessionFile).toBe(file));
  return (await store.listSessions())[0];
}

describe("background pi session", () => {
  test("a panel that attaches gets the current chat replayed", () => {
    expect(updates()[0]).toMatchObject({ kind: "replay", status: "disconnected", session: { id: 0, title: "" }, history: [], live: [] });
    expect(updates()[1]).toEqual({ kind: "sessions", sessions: [], currentId: 0, running: [] });
  });

  test("the first message starts pi and turns the draft into a stored chat named after it, tab mentions as @title", async () => {
    const text = "Plan a trip like [@Kyoto in 3 days](https://example.com/kyoto), with temples, food markets and a day in Nara";
    await pi.prompt(text);
    expect(bridge().sent).toEqual([
      { type: "start", sessionFile: undefined, piPath: undefined },
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
    fromBridge({ type: "ready", sessionFile: SESSION_FILE, history: HISTORY, model: { models: [] }, commands: [{ name: "skill:demo" }] });
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
    expect(bridge().sent).toEqual([{ type: "start", sessionFile: SESSION_FILE, piPath: "/opt/pi" }]);
    expect(last("status")).toEqual({ kind: "status", status: "connecting" });
  });

  test("a new chat starts its own pi and stays a draft until its first message", async () => {
    await storedChat();
    const old = bridge();
    await pi.newSession();
    expect(bridge()).not.toBe(old);
    expect(bridge().sent).toEqual([{ type: "start", sessionFile: undefined, piPath: undefined }]);
    expect(last("replay")).toMatchObject({ session: { id: 0 }, history: [], live: [] });

    ready("/sessions/new.jsonl");
    await waitFor(() => expect(last("replay")?.status).toBe("connected"));
    expect(await store.listSessions()).toHaveLength(1);
  });

  test("a new chat asked for while the first message is still being stored opens after it", async () => {
    await Promise.all([pi.prompt("first"), pi.newSession()]);
    expect((await store.listSessions()).map((chat) => chat.title)).toEqual(["first"]);
    expect(chromeFake.nativePorts[0].sent.map((request: { type: string }) => request.type)).toEqual(["start", "prompt"]);
    expect(last("replay")).toMatchObject({ session: { id: 0 }, live: [] });
  });

  test("a message sent just before a chat switch stays in the chat it was sent from", async () => {
    await storedChat();
    const old = bridge();
    await Promise.all([pi.prompt("again"), pi.newSession()]);
    expect(old.sent.at(-1)).toMatchObject({ type: "prompt", text: "again" });
    expect(bridge().sent).not.toContainEqual(expect.objectContaining({ type: "prompt" }));
    expect(last("replay")).toMatchObject({ session: { id: 0 }, live: [] });
  });

  test("stop isn't held up behind a message still being stored", async () => {
    await storedChat();
    const sending = pi.prompt("again");
    pi.abort();
    expect(bridge().sent.at(-1)).toEqual({ type: "abort" });
    await sending;
  });

  test("switching back to a stored chat starts pi on its session file", async () => {
    const chat = await storedChat();
    await pi.newSession();
    ready("/sessions/new.jsonl");
    await pi.switchSession(chat.id);
    expect(bridge().sent).toEqual([{ type: "start", sessionFile: SESSION_FILE, piPath: undefined }]);
    expect(last("replay")?.session.id).toBe(chat.id);
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
    fromBridge({ type: "history", sessionFile: SESSION_FILE, history: HISTORY });
    expect(last("replay")).toMatchObject({ status: "connecting", history: HISTORY });
  });

  test("deleting the current chat stops its pi, even mid-run, and moves to the next one or a new draft", async () => {
    const chat = await storedChat();
    chunk({ type: "run_start", at: 1 });
    const old = bridge();
    await pi.deleteSession(chat.id);
    expect(await store.listSessions()).toEqual([]);
    expect(old.disconnected).toBe(true);
    expect(bridge().sent).toEqual([{ type: "start", sessionFile: undefined, piPath: undefined }]);
    expect(last("replay")?.session.id).toBe(0);
    expect(last("sessions")).toEqual({ kind: "sessions", sessions: [], currentId: 0, running: [] });
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
    const { id } = (await store.listSessions())[0];
    await waitFor(() => expect(chromeFake.storage.get("held")).toEqual({ [id]: [{ text: "keep me" }] }));
    // The panel closes while the held text is read from storage.
    const brief = new FakePort("panel");
    const read = chromeFake.storage.get.bind(chromeFake.storage);
    const reading = spyOn(chromeFake.storage, "get").mockImplementation((key: string) => {
      if (key === "held") brief.close();
      return read(key);
    });
    try {
      await pi.attachPanel(brief.port).catch(() => undefined);
    } finally {
      reading.mockRestore();
    }
    expect(last("restore", await attach())).toEqual({ kind: "restore", text: "keep me" });
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

  describe("while pi works", () => {
    async function working() {
      const chat = await storedChat();
      busy(true);
      chunk({ type: "run_start", at: 1 });
      return chat;
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
      fromBridge({ type: "queue", queue: [{ text: "later", steer: false }] });
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

    test("switching chats shows the next chat's queue, and the left chat's queue when back", async () => {
      const chat = await working();
      fromBridge({ type: "queue", queue: [{ text: "later", steer: false }] });
      await pi.newSession();
      expect(last("replay")?.queue).toEqual([]);
      await pi.switchSession(chat.id);
      expect(last("replay")?.queue).toEqual([{ text: "later", steer: false }]);
    });
  });

  describe("chats running side by side", () => {
    // A stored chat whose pi is mid-run, left for a new chat.
    async function leftRunning() {
      const chat = await storedChat();
      busy(true);
      chunk({ type: "run_start", at: 1 });
      const port = bridge();
      await pi.newSession();
      return { chat, port };
    }

    test("leaving a working chat lets it go on: no stop, and its pi keeps running", async () => {
      const { port } = await leftRunning();
      expect(port.disconnected).toBe(false);
      expect(port.sent).not.toContainEqual({ type: "abort" });
      expect(bridge()).not.toBe(port);
    });

    test("what a chat sends while the user is in another shows in that chat, not the one on screen", async () => {
      const { chat, port } = await leftRunning();
      ready("/sessions/new.jsonl");
      const seen = updates().length;
      chunk({ type: "text", content: "Day 2 in Nara" }, port);
      expect(liveChunks()).toEqual([]);
      expect(updates().slice(seen)).not.toContainEqual(expect.objectContaining({ kind: "live" }));

      const ports = chromeFake.nativePorts.length;
      await pi.switchSession(chat.id);
      // Back to the pi that kept working, not a new one.
      expect(chromeFake.nativePorts).toHaveLength(ports);
      expect(last("replay")).toMatchObject({ status: "connected", history: HISTORY });
      expect(liveChunks().slice(-2)).toEqual([{ type: "run_start", at: 1 }, { type: "text", content: "Day 2 in Nara" }]);
      chunk({ type: "text", content: "and back" }, port);
      expect(last("live")?.chunk).toEqual({ type: "text", content: "and back" });
    });

    test("two chats take messages at the same time, each on its own pi", async () => {
      const { port } = await leftRunning();
      await pi.prompt("a second trip");
      expect(bridge().sent.at(-1)).toMatchObject({ type: "prompt", text: "a second trip" });
      expect(port.sent).not.toContainEqual(expect.objectContaining({ text: "a second trip" }));
      pi.abort();
      expect(bridge().sent.at(-1)).toEqual({ type: "abort" });
      expect(port.sent).not.toContainEqual({ type: "abort" });
    });

    test("the chat list marks chats that are working", async () => {
      const { chat, port } = await leftRunning();
      expect(last("sessions")?.running).toEqual([chat.id]);
      chunk({ type: "run_end", at: 2 }, port);
      await waitFor(() => expect(last("sessions")?.running).toEqual([]));
    });

    test("a chat working off screen keeps its pi until its bridge has nothing left, even past its run's end", async () => {
      const { port } = await leftRunning();
      // Queued messages on their way back to pi as the run ends.
      chunk({ type: "run_end", at: 2 }, port);
      expect(port.disconnected).toBe(false);
      busy(false, port);
      expect(port.disconnected).toBe(true);
    });

    test("a chat left with a message pi hasn't answered keeps its pi until the bridge is done", async () => {
      await storedChat();
      const port = bridge();
      await pi.prompt("one more day");
      await pi.newSession();
      expect(port.disconnected).toBe(false);
      busy(true, port);
      const sent = port.sent.findLast((r: { type: string }) => r.type === "prompt") as { promptId: string };
      fromBridge({ type: "prompt_result", promptId: sent.promptId, started: true }, port);
      expect(port.disconnected).toBe(false);
      busy(false, port);
      expect(port.disconnected).toBe(true);
    });

    test("a message a stop takes back off screen still reaches its chat's message box", async () => {
      await storedChat();
      const port = bridge();
      busy(true);
      const chat = (await store.listSessions())[0];
      await pi.prompt("later");
      await pi.newSession();
      const sent = port.sent.findLast((r: { type: string }) => r.type === "prompt") as { promptId: string };
      // The bridge answers a stopped message before handing it back.
      fromBridge({ type: "prompt_result", promptId: sent.promptId, started: false }, port);
      fromBridge({ type: "restore", text: "later" }, port);
      busy(false, port);
      expect(port.disconnected).toBe(true);
      await pi.switchSession(chat.id);
      expect(last("restore")).toEqual({ kind: "restore", text: "later" });
    });

    test("a chat left while its pi is still starting doesn't leave a pi behind", async () => {
      await storedChat();
      await restartWorker();
      // The panel's start and a click on New chat, at once.
      await Promise.all([pi.start(), pi.newSession()]);
      expect(chromeFake.nativePorts.slice(1).filter((port) => !port.disconnected)).toHaveLength(1);
    });

    test("restarting a working chat clears its spinner", async () => {
      const chat = await storedChat();
      busy(true);
      chunk({ type: "run_start", at: 1 });
      await waitFor(() => expect(last("sessions")?.running).toEqual([chat.id]));
      await pi.restart();
      await waitFor(() => expect(last("sessions")?.running).toEqual([]));
    });

    test("a chat left while its pi restarts mid-run doesn't leave a pi behind", async () => {
      await storedChat();
      busy(true);
      chunk({ type: "run_start", at: 1 });
      const ports = chromeFake.nativePorts.length;
      await Promise.all([pi.restart(), pi.newSession()]);
      expect(chromeFake.nativePorts.slice(ports).filter((port) => !port.disconnected)).toHaveLength(1);
    });

    test("a chat left right after asking its pi for something keeps its pi until the bridge is done with it", async () => {
      await storedChat();
      const port = bridge();
      await pi.compact();
      // The bridge hasn't reported the compaction yet.
      await pi.newSession();
      expect(port.disconnected).toBe(false);
      busy(true, port);
      busy(false, port);
      expect(port.disconnected).toBe(true);
    });

    test("an idle report sent before the bridge got a request doesn't stop the chat", async () => {
      await storedChat();
      const port = bridge();
      const before = received(port);
      await pi.compact();
      await pi.newSession();
      // Sent as the last run settled, read only now.
      busy(false, port, before);
      expect(port.disconnected).toBe(false);
      busy(true, port);
      busy(false, port);
      expect(port.disconnected).toBe(true);
    });

    test("text a chat hands back off screen survives a worker restart", async () => {
      const { chat, port } = await leftRunning();
      fromBridge({ type: "restore", text: "draft a reply" }, port);
      busy(false, port);
      expect(port.disconnected).toBe(true);
      await restartWorker();
      await pi.switchSession(chat.id);
      await waitFor(() => expect(last("restore")).toEqual({ kind: "restore", text: "draft a reply" }));
    });

    test("text a chat handed back off screen goes to that chat even if the user moves on while it's taken from storage", async () => {
      const { chat, port } = await leftRunning();
      fromBridge({ type: "restore", text: "draft a reply" }, port);
      busy(false, port);
      const write = chrome.storage.local.set.bind(chrome.storage.local);
      // The user opens a new chat while the held text is being cleared.
      const moving = spyOn(chrome.storage.local, "set").mockImplementation(async (items: Record<string, unknown>) => {
        if (JSON.stringify(items) === '{"held":{}}') await pi.newSession();
        return write(items);
      });
      try {
        await pi.switchSession(chat.id);
        await waitFor(() => expect(last("replay")?.session.id).toBe(0));
        await new Promise((resolve) => setTimeout(resolve, 10));
      } finally {
        moving.mockRestore();
      }
      // Shown while its own chat was on screen.
      const shown = updates().findIndex((u) => u.kind === "restore");
      const screen = updates().slice(0, shown).findLast((u): u is Extract<PanelUpdate, { kind: "replay" }> => u.kind === "replay");
      expect(screen?.session.id).toBe(chat.id);
    });

    test("pi's late answer to a message doesn't bring back the spinner of a run that already ended", async () => {
      const chat = await storedChat();
      await pi.prompt("quick one");
      const sent = bridge().sent.findLast((r: { type: string }) => r.type === "prompt") as { promptId: string };
      chunk({ type: "run_start", at: 1 });
      chunk({ type: "run_end", at: 2 });
      fromBridge({ type: "prompt_result", promptId: sent.promptId, started: true });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(last("sessions")?.running).not.toContain(chat.id);
    });

    test("leaving an idle chat stops its pi", async () => {
      await storedChat();
      const port = bridge();
      await pi.newSession();
      expect(port.disconnected).toBe(true);
    });

    test("deleting a chat working in the background stops its pi", async () => {
      const { chat, port } = await leftRunning();
      await pi.deleteSession(chat.id);
      expect(port.disconnected).toBe(true);
      expect(last("sessions")?.running).toEqual([]);
    });

    test("text a background chat hands back waits for that chat, not the message box on screen", async () => {
      const { chat, port } = await leftRunning();
      fromBridge({ type: "restore", text: "draft a reply" }, port);
      expect(last("restore")).toBeUndefined();
      await pi.switchSession(chat.id);
      expect(last("restore")).toEqual({ kind: "restore", text: "draft a reply" });
    });
  });
});
