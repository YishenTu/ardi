import { afterEach, expect, test } from "bun:test";
import { ChromeBrowserController } from "../../../../../src/targets/chrome/background/browser";
import { chromeFake } from "../../../../support/chrome";

let controller: ChromeBrowserController | undefined;
afterEach(async () => { await controller?.dispose(); controller = undefined; });
function setup() {
  chromeFake.tabs = [
    { id: 10, url: "https://one.test/", title: "One", active: true, windowId: 1, status: "complete" },
    { id: 20, url: "https://two.test/", title: "Two", active: true, windowId: 2, status: "complete" },
    { id: 30, url: "chrome://settings/", title: "Settings", windowId: 2 },
  ];
  chromeFake.focusedWindow = 2;
  return controller = new ChromeBrowserController();
}

test("lists only web pages and identifies this page in the focused window", async () => {
  const browser = setup();
  expect(await browser.execute({ op: "list" })).toEqual([
    { id: "10", title: "One", url: "https://one.test/", current: false },
    { id: "20", title: "Two", url: "https://two.test/", current: true },
  ]);
  chromeFake.onDebuggerCommand = () => ({ result: { value: "page text" } });
  expect(await browser.execute({ op: "eval", code: "document.body.innerText" })).toMatchObject({ tab: { id: "20" }, value: "page text" });
  expect(chromeFake.debuggerCommands[0].target).toEqual({ tabId: 20 });
});

test("explicit tab selection stays bound to that tab; restricted or missing targets fail", async () => {
  const browser = setup();
  chromeFake.onDebuggerCommand = () => ({ result: { value: 42 } });
  await browser.execute({ op: "eval", id: "10", code: "42" });
  expect(chromeFake.debuggerCommands[0].target).toEqual({ tabId: 10 });
  await expect(browser.execute({ op: "eval", id: "30", code: "42" })).rejects.toThrow("web page");
  await expect(browser.execute({ op: "eval", id: "99", code: "42" })).rejects.toThrow();
  await expect(browser.execute({ op: "cdp", id: "10", method: "Browser.close" })).rejects.toThrow("supported");
});

test("parallel commands share attachment and shutdown detaches without closing tabs", async () => {
  const browser = setup();
  chromeFake.onDebuggerCommand = () => ({ result: { value: true } });
  await Promise.all([browser.execute({ op: "eval", id: "10", code: "1" }), browser.execute({ op: "eval", id: "10", code: "2" })]);
  expect(chromeFake.debuggerAttached).toEqual([10]);
  await browser.dispose();
  expect(chromeFake.debuggerDetached).toEqual([10]);
  expect(chromeFake.tabs).toHaveLength(3);
  await expect(browser.execute({ op: "list" })).rejects.toThrow("disconnected");
});

test("user cancellation blocks every browser operation until another user prompt", async () => {
  const browser = setup();
  await browser.execute({ op: "cdp", id: "10", method: "Input.insertText", params: { text: "hello" } });
  chromeFake.debuggerDetach.emit({ tabId: 10 }, "canceled_by_user");
  await expect(browser.execute({ op: "eval", id: "10", code: "1" })).rejects.toThrow("canceled");
  await expect(browser.execute({ op: "cdp", id: "20", method: "Input.insertText", params: { text: "after cancel" } })).rejects.toThrow("canceled");
  await expect(browser.execute({ op: "open", url: "https://new.test/" })).rejects.toThrow("canceled");
  await expect(browser.execute({ op: "close", id: "10" })).rejects.toThrow("canceled");
  await expect(browser.execute({ op: "list" })).rejects.toThrow("canceled");
  expect(chromeFake.debuggerCommands).toHaveLength(1);
  expect(chromeFake.createdTabs).toHaveLength(0);
  expect(chromeFake.tabs).toHaveLength(3);
  expect(chromeFake.debuggerAttached).toEqual([10]);
  browser.preparePrompt()();
  await browser.execute({ op: "eval", id: "20", code: "1" });
  expect(chromeFake.debuggerAttached).toEqual([10, 20]);
});

for (const op of ["close", "cdp"] as const) {
  test(`user cancellation during tab lookup prevents queued ${op}`, async () => {
    const browser = setup();
    await browser.execute({ op: "eval", id: "10", code: "1" });
    const originalGet = chrome.tabs.get;
    let resolve!: (tab: chrome.tabs.Tab) => void;
    chrome.tabs.get = () => new Promise<chrome.tabs.Tab>(done => { resolve = done; });
    try {
      const request = browser.execute(op === "close" ? { op, id: "20" } : { op, id: "20", method: "Input.insertText", params: { text: "queued" } });
      chromeFake.debuggerDetach.emit({ tabId: 10 }, "canceled_by_user");
      resolve({ ...chromeFake.tabs[1] } as chrome.tabs.Tab);
      await expect(request).rejects.toThrow("canceled");
      expect(chromeFake.debuggerCommands).toHaveLength(1);
      expect(chromeFake.tabs).toHaveLength(3);
    } finally { chrome.tabs.get = originalGet; }
  });
}

test("JavaScript exceptions reach the tool instead of looking like success", async () => {
  const browser = setup();
  chromeFake.onDebuggerCommand = () => ({ exceptionDetails: { text: "Uncaught", exception: { description: "Error: fixture failure" } } });
  await expect(browser.execute({ op: "eval", code: "throw new Error()" })).rejects.toThrow("fixture failure");
});

test("opening a background tab preserves the current tab and returns its loaded identity", async () => {
  const browser = setup();
  const opened = await browser.execute({ op: "open", url: "https://new.test/", background: true });
  expect(opened).toMatchObject({ url: "https://new.test/", current: false });
  expect(chromeFake.createdTabs).toEqual([{ url: "https://new.test/", active: false }]);
  await expect(browser.execute({ op: "open", url: "chrome://settings/" })).rejects.toThrow("web page");
});

test("disconnect during tab lookup prevents a queued close from mutating the browser", async () => {
  const browser = setup();
  const originalGet = chrome.tabs.get;
  let resolve!: (tab: chrome.tabs.Tab) => void;
  chrome.tabs.get = () => new Promise<chrome.tabs.Tab>(done => { resolve = done; });
  try {
    const closing = browser.execute({ op: "close", id: "10" });
    await browser.dispose();
    resolve({ ...chromeFake.tabs[0] } as chrome.tabs.Tab);
    await expect(closing).rejects.toThrow("disconnected");
    expect(chromeFake.tabs).toHaveLength(3);
  } finally { chrome.tabs.get = originalGet; }
});
