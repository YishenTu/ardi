import { afterEach, expect, test } from "bun:test";
import registerChromeTools from "../../../../../../src/targets/chrome/agent/extension/tools";
import type { BrowserLink } from "../../../../../../src/background/target";
import { connectBrowser } from "../../../../../../src/targets/chrome/background/browser";
import { ChromeBrowserRelay } from "../../../../../../src/targets/chrome/bridge/relay";
import { waitFor } from "../../../../../support/wait";
import { chromeFake } from "../../../../../support/chrome";

let relay: ChromeBrowserRelay;
let link: BrowserLink | undefined;
let canceledRequests = 0;
const previous = { url: process.env.ARDI_BROWSER_URL, token: process.env.ARDI_BROWSER_TOKEN };
afterEach(async () => {
  relay?.dispose();
  await link?.dispose();
  if (previous.url === undefined) delete process.env.ARDI_BROWSER_URL; else process.env.ARDI_BROWSER_URL = previous.url;
  if (previous.token === undefined) delete process.env.ARDI_BROWSER_TOKEN; else process.env.ARDI_BROWSER_TOKEN = previous.token;
});
// Pi's tools, the bridge's relay and the background's link, wired as the
// native connection would.
async function setup() {
  chromeFake.tabs = [{ id: 42, title: "User tab", url: "https://user.test/", active: true, windowId: 1, status: "complete" }];
  const background = connectBrowser(reply => relay.reply(reply));
  link = background;
  canceledRequests = 0;
  relay = await ChromeBrowserRelay.start(event => {
    if (event.type === "browser_cancel") canceledRequests++;
    if (event.type === "browser_cancel" || event.type === "browser_request") background.receive(event);
  });
  process.env.ARDI_BROWSER_URL = relay.url;
  process.env.ARDI_BROWSER_TOKEN = relay.token;
  const tools: Record<string, any> = {};
  registerChromeTools({ registerTool: (tool: any) => tools[tool.name] = tool } as any);
  return tools;
}

test("Pi tools list and read the current tab through the real relay and background controller", async () => {
  const tools = await setup();
  const listed = await tools.list_tabs.execute("list", {}, undefined);
  expect(listed.details).toEqual([{ id: "42", title: "User tab", url: "https://user.test/", current: true }]);
  chromeFake.onDebuggerCommand = () => ({ result: { value: "Visible text in the user's session" } });
  const read = await tools.read_tab.execute("read", {}, undefined);
  expect(read.content[0].text).toContain("Visible text in the user's session");
  expect(read.details.id).toBe("42");
  expect(chromeFake.debuggerCommands[0].target.tabId).toBe(42);
});

test("browser_exec sends JavaScript or real input commands and propagates failures", async () => {
  const tools = await setup();
  chromeFake.onDebuggerCommand = () => ({ result: { value: "clicked" } });
  expect((await tools.browser_exec.execute("run", { code: 'document.querySelector("button").click()' }, undefined)).content[0].text).toBe("clicked");
  await tools.browser_exec.execute("type", { id: "42", method: "Input.insertText", params: { text: "Hello" } }, undefined);
  expect(chromeFake.debuggerCommands.at(-1)).toMatchObject({ target: { tabId: 42 }, method: "Input.insertText", params: { text: "Hello" } });
  chromeFake.onDebuggerCommand = () => ({ exceptionDetails: { text: "Page script failed" } });
  await expect(tools.browser_exec.execute("fail", { code: "throw 1" }, undefined)).rejects.toThrow("Page script failed");
  await expect(tools.browser_exec.execute("invalid", { code: "1", method: "Input.insertText" }, undefined)).rejects.toThrow("exactly one");
});

test("open_tab keeps the user's page active by default; canceled tools do not issue commands", async () => {
  const tools = await setup();
  const opened = await tools.open_tab.execute("open", { url: "https://new.test/" }, undefined);
  expect(opened.details.url).toBe("https://new.test/");
  expect(chromeFake.createdTabs[0].active).toBe(false);
  const abort = new AbortController(); abort.abort();
  await expect(tools.browser_exec.execute("cancel", { code: "1" }, abort.signal)).rejects.toThrow();
  expect(chromeFake.debuggerCommands).toHaveLength(0);
});

test("Stop after dispatch cancels a queued browser mutation across the relay", async () => {
  const tools = await setup();
  const originalGet = chrome.tabs.get;
  let release: ((tab: chrome.tabs.Tab) => void) | undefined;
  chrome.tabs.get = () => new Promise<chrome.tabs.Tab>(done => { release = done; });
  const abort = new AbortController();
  try {
    const operation = tools.browser_exec.execute("typing", { id: "42", method: "Input.insertText", params: { text: "must not type" } }, abort.signal);
    await waitFor(() => expect(release).toBeDefined());
    abort.abort();
    await expect(operation).rejects.toThrow();
    await waitFor(() => expect(canceledRequests).toBe(1));
    release!({ ...chromeFake.tabs[0] } as chrome.tabs.Tab);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(chromeFake.debuggerCommands).toHaveLength(0);
  } finally {
    await link?.dispose();
    release?.({ ...chromeFake.tabs[0] } as chrome.tabs.Tab);
    chrome.tabs.get = originalGet;
  }
});
