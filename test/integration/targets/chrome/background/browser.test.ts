// The background's chat and pi connection with Chrome's browser link: pi's
// browser requests run here, and Stop and new prompts gate them. Each test
// imports a fresh copy of the background, as in pi-session.test.ts.
import "../../../../support/indexeddb";

import { beforeEach, expect, spyOn, test } from "bun:test";

import { chromeFake } from "../../../../support/chrome";
import { waitFor } from "../../../../support/wait";
import type { BridgeEvent } from "../../../../../src/bridge/protocol";
import * as store from "../../../../../src/background/store";
import { setTarget } from "../../../../../src/background/target";
import { connectBrowser } from "../../../../../src/targets/chrome/background/browser";

type Background = typeof import("../../../../../src/background/pi-session");

let pi: Background;
let copies = 0;

beforeEach(async () => {
  setTarget({ nativeHost: "com.ardi.chrome.test", connectBrowser });
  for (const chat of await store.listSessions()) await store.deleteSession(chat.id);
  pi = (await import(`../../../../../src/background/pi-session.ts?chrome=${copies++}`)) as Background;
});

const bridge = () => chromeFake.nativePorts.at(-1)!;
const fromBridge = (event: BridgeEvent) => bridge().receive(event);

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
