// The background's chat and pi connection, driven like the panel and the
// bridge would. The module keeps its chat and connection for the worker's
// lifetime, so each test imports a fresh copy and starts from an empty list.
import "../../support/indexeddb";

import { IDBObjectStore } from "fake-indexeddb";
import { beforeEach, describe, expect, spyOn, test } from "bun:test";

import { chromeFake, FakePort } from "../../support/chrome";
import { waitFor } from "../../support/wait";
import type { BridgeEvent } from "../../../src/bridge/protocol";
import type { ChatChunk, ChatMessage } from "../../../src/chat";
import type { PanelUpdate } from "../../../src/shared";
import * as store from "../../../src/background/store";

type Background = typeof import("../../../src/background/pi-session");

let pi: Background;
let panel: FakePort;
let copies = 0;

beforeEach(async () => {
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
const chunk = (chunk: ChatChunk) => fromBridge({ type: "chunk", chunk });
const ready = (sessionFile?: string, history: ChatMessage[] = []) =>
  fromBridge({ type: "ready", sessionFile, history, model: { models: [] }, commands: [] });
const liveChunks = () => last("replay")!.live.filter((item) => item.kind === "chunk");

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
      { type: "start", sessionFile: undefined, piPath: undefined },
      { type: "prompt", text, promptId: expect.any(String) },
    ]);
    expect(last("live")).toEqual({ kind: "live", item: { kind: "prompt", text, at: expect.any(Number) } });
    const [chat] = await store.listSessions();
    expect(chat.title).toBe("Plan a trip like @Kyoto in 3 days, with temples, food market");
    await waitFor(() => expect(last("sessions")?.sessions).toHaveLength(1));
  });

  test("starting twice at once opens one bridge", async () => {
    await Promise.all([pi.start(), pi.start()]);
    expect(chromeFake.nativePorts).toHaveLength(1);
  });

  test("ready saves pi's session file on the chat and replays history, keeping prompts sent meanwhile", async () => {
    await pi.prompt("earlier");
    fromBridge({ type: "ready", sessionFile: SESSION_FILE, history: HISTORY, model: { models: [] }, commands: [{ name: "skill:demo" }] });
    await waitFor(async () => expect((await store.listSessions())[0].piSessionFile).toBe(SESSION_FILE));
    expect(last("replay")).toMatchObject({ status: "connected", history: HISTORY, commands: [{ name: "skill:demo" }], live: [{ kind: "prompt", text: "earlier" }] });
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
    expect(last("live")).toEqual({ kind: "live", item: { kind: "chunk", chunk: { type: "text", content: "Day 1" } } });

    const big = JSON.stringify({ type: "chunk", chunk: { type: "text", content: "x".repeat(1000) } });
    bridge().receive({ type: "part", data: big.slice(0, 400), last: false });
    bridge().receive({ type: "part", data: big.slice(400), last: true });
    expect(last("live")).toEqual({ kind: "live", item: { kind: "chunk", chunk: { type: "text", content: "x".repeat(1000) } } });
  });

  test("closing the panel leaves pi running, and a new panel gets what happened meanwhile", async () => {
    await storedChat();
    panel.close();
    chunk({ type: "text", content: "Day 1" });
    expect(bridge().disconnected).toBe(false);
    const next = await attach();
    expect(last("replay", next)?.live).toContainEqual({ kind: "chunk", chunk: { type: "text", content: "Day 1" } });
  });

  test("a fatal bridge error shows as an error notice", async () => {
    await pi.start();
    fromBridge({ type: "fatal", message: "pi exited (code 1)" });
    expect(last("live")?.item).toEqual({ kind: "chunk", chunk: { type: "notice", content: "pi exited (code 1)", level: "error" } });
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

  test("a new chat moves the running pi with open and stays a draft until its first message", async () => {
    await storedChat();
    await pi.newSession();
    expect(bridge().sent.at(-1)).toEqual({ type: "open", sessionFile: undefined });
    expect(last("replay")).toMatchObject({ session: { id: 0 }, history: [], live: [] });

    ready("/sessions/new.jsonl");
    await waitFor(() => expect(last("replay")?.status).toBe("connected"));
    expect(await store.listSessions()).toHaveLength(1);
  });

  test("switching back to a stored chat opens its session file", async () => {
    const chat = await storedChat();
    await pi.newSession();
    ready("/sessions/new.jsonl");
    await pi.switchSession(chat.id);
    expect(bridge().sent.at(-1)).toEqual({ type: "open", sessionFile: SESSION_FILE });
    expect(last("replay")?.session.id).toBe(chat.id);
  });

  test("what a stopped run still sends while pi switches chats stays out of the next chat", async () => {
    await storedChat();
    chunk({ type: "run_start", at: 1 });
    await pi.newSession();
    // pi stops the run before switching; its last output arrives before `ready`.
    chunk({ type: "text", content: "the rest of Kyoto" });
    chunk({ type: "run_end", at: 2, interrupted: true });
    ready("/sessions/new.jsonl");
    await waitFor(() => expect(last("replay")?.status).toBe("connected"));
    expect(liveChunks()).toEqual([]);

    chunk({ type: "text", content: "Hi" });
    expect(last("live")?.item).toEqual({ kind: "chunk", chunk: { type: "text", content: "Hi" } });
  });

  test("a ready that answers an earlier start or open isn't applied to the chat the user moved to", async () => {
    await storedChat();
    await pi.restart();
    await pi.newSession();
    // The restart's `ready`, for the chat the user just left.
    ready(SESSION_FILE, HISTORY);
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
    fromBridge({ type: "history", sessionFile: "/sessions/other.jsonl", history: [] });
    expect(last("replay")?.history).toBeNull();
    fromBridge({ type: "history", sessionFile: SESSION_FILE, history: HISTORY });
    expect(last("replay")).toMatchObject({ status: "connecting", history: HISTORY });
  });

  test("deleting the current chat moves to the next one, or a new draft", async () => {
    const chat = await storedChat();
    await pi.deleteSession(chat.id);
    expect(await store.listSessions()).toEqual([]);
    expect(bridge().sent.at(-1)).toEqual({ type: "open", sessionFile: undefined });
    expect(last("replay")?.session.id).toBe(0);
    expect(last("sessions")).toEqual({ kind: "sessions", sessions: [], currentId: 0 });
  });

  test("when the bridge goes away, the panel sees pi as not running", async () => {
    await pi.start();
    bridge().close("Native host has exited.");
    expect(last("status")).toEqual({ kind: "status", status: "disconnected" });
  });
});

test("browser requests execute in this extension and replies return to their originating native port", async () => {
  await pi.start();
  chromeFake.tabs = [{ id: 7, title: "Here", url: "https://here.test/", active: true, windowId: 1 }];
  fromBridge({ type: "browser_request", id: "r1", request: { op: "list" } });
  await waitFor(() => expect(bridge().sent).toContainEqual({ type: "browser_reply", id: "r1", result: [{ id: "7", title: "Here", url: "https://here.test/", current: true }] }));
  fromBridge({ type: "browser_request", id: "r2", request: { op: "eval", id: "999", code: "1" } });
  await waitFor(() => expect(bridge().sent).toContainEqual({ type: "browser_reply", id: "r2", error: expect.stringContaining("No tab") }));
  const old = bridge();
  await pi.restart();
  old.receive({ type: "browser_request", id: "stale", request: { op: "list" } });
  await Promise.resolve();
  expect(bridge().sent.some(e => e.id === "stale")).toBe(false);
});

test("Stop blocks browser work immediately and a new prompt cannot revive queued work", async () => {
  await pi.start();
  chromeFake.tabs = [{ id: 7, title: "Here", url: "https://here.test/", active: true, windowId: 1 }];
  const originalGet = chrome.tabs.get;
  let resolve!: (tab: chrome.tabs.Tab) => void;
  chrome.tabs.get = () => new Promise<chrome.tabs.Tab>(done => { resolve = done; });
  try {
    fromBridge({ type: "browser_request", id: "queued", request: { op: "cdp", id: "7", method: "Input.insertText", params: { text: "stale" } } });
    pi.abort();
    // No browser_cancel event from the relay: Stop itself must stop work.
    fromBridge({ type: "browser_request", id: "after-stop", request: { op: "open", url: "https://new.test/" } });
    await waitFor(() => expect(bridge().sent).toContainEqual({ type: "browser_reply", id: "after-stop", error: expect.stringContaining("canceled") }));
    await pi.prompt("Continue now");
    const accepted = bridge().sent.findLast(e => e.type === "prompt")!;
    fromBridge({ type: "prompt_result", promptId: accepted.promptId, started: true });
    resolve({ ...chromeFake.tabs[0] } as chrome.tabs.Tab);
    await waitFor(() => expect(bridge().sent).toContainEqual({ type: "browser_reply", id: "queued", error: expect.stringContaining("canceled") }));
    expect(chromeFake.debuggerCommands).toHaveLength(0);
    expect(chromeFake.createdTabs).toHaveLength(0);
  } finally { chrome.tabs.get = originalGet; }
  fromBridge({ type: "browser_request", id: "fresh", request: { op: "cdp", id: "7", method: "Input.insertText", params: { text: "fresh" } } });
  await waitFor(() => expect(chromeFake.debuggerCommands).toHaveLength(1));
  expect(chromeFake.debuggerCommands[0].params).toEqual({ text: "fresh" });
});

test("a rejected prompt does not lift banner cancellation", async () => {
  await pi.start();
  chromeFake.tabs = [{ id: 7, title: "Here", url: "https://here.test/", active: true, windowId: 1 }];
  chromeFake.debuggerDetach.emit({ tabId: 7 }, "canceled_by_user");
  await pi.prompt("Rejected while the old run is busy");
  const prompt = bridge().sent.findLast(e => e.type === "prompt")!;
  fromBridge({ type: "prompt_result", promptId: prompt.promptId, started: false });
  fromBridge({ type: "browser_request", id: "rejected", request: { op: "cdp", id: "7", method: "Input.insertText", params: { text: "old run" } } });
  await waitFor(() => expect(bridge().sent).toContainEqual({ type: "browser_reply", id: "rejected", error: expect.stringContaining("canceled") }));
  expect(chromeFake.debuggerCommands).toHaveLength(0);
});

test("a second prompt cannot disconnect queued work from later banner cancellation", async () => {
  await pi.start();
  chromeFake.tabs = [{ id: 7, title: "Here", url: "https://here.test/", active: true, windowId: 1 }];
  const originalGet = chrome.tabs.get;
  let resolve!: (tab: chrome.tabs.Tab) => void;
  chrome.tabs.get = () => new Promise<chrome.tabs.Tab>(done => { resolve = done; });
  try {
    fromBridge({ type: "browser_request", id: "queued-before-prompt", request: { op: "cdp", id: "7", method: "Input.insertText", params: { text: "stale" } } });
    await pi.prompt("Another request");
    const prompt = bridge().sent.findLast(e => e.type === "prompt")!;
    fromBridge({ type: "prompt_result", promptId: prompt.promptId, started: true });
    chromeFake.debuggerDetach.emit({ tabId: 7 }, "canceled_by_user");
    resolve({ ...chromeFake.tabs[0] } as chrome.tabs.Tab);
    await waitFor(() => expect(bridge().sent).toContainEqual({ type: "browser_reply", id: "queued-before-prompt", error: expect.stringContaining("canceled") }));
    expect(chromeFake.debuggerCommands).toHaveLength(0);
  } finally { chrome.tabs.get = originalGet; }
});

test("a late prompt acceptance cannot lift a newer Stop", async () => {
  await pi.start();
  pi.abort();
  await pi.prompt("Start a new run");
  const prompt = bridge().sent.findLast(e => e.type === "prompt")!;
  pi.abort();
  fromBridge({ type: "prompt_result", promptId: prompt.promptId, started: true });
  fromBridge({ type: "browser_request", id: "late-acceptance", request: { op: "open", url: "https://new.test/" } });
  await waitFor(() => expect(bridge().sent).toContainEqual({ type: "browser_reply", id: "late-acceptance", error: expect.stringContaining("canceled") }));
  expect(chromeFake.createdTabs).toHaveLength(0);
});


test("a prompt saved during bridge restart is delivered to the replacement port", async () => {
  await pi.start();
  const previous = bridge();
  const addSession = store.addSession;
  let saving = false;
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const save = spyOn(store, "addSession").mockImplementation(async meta => {
    saving = true;
    await pending;
    return addSession(meta);
  });
  try {
    const sending = pi.prompt("Keep this message");
    await waitFor(() => expect(saving).toBe(true));
    await pi.restart();
    release();
    await sending;
    expect(bridge()).not.toBe(previous);
    expect(bridge().sent).toContainEqual({ type: "prompt", text: "Keep this message", promptId: undefined });
    expect(previous.sent.some(message => message.type === "prompt")).toBe(false);
  } finally { release(); save.mockRestore(); }
});
