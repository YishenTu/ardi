import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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
// `legacy` stands in for a service worker that predates this tool: it
// answers every request the way older builds answer an unknown one.
async function setup({ legacy = false } = {}) {
  chromeFake.tabs = [{ id: 42, title: "User tab", url: "https://user.test/", active: true, windowId: 1, status: "complete" }];
  const background = connectBrowser(reply => relay.reply(reply));
  link = background;
  canceledRequests = 0;
  relay = await ChromeBrowserRelay.start(event => {
    if (event.type === "browser_cancel") canceledRequests++;
    if (legacy && event.type === "browser_request") return void setTimeout(() => relay.reply({ type: "browser_reply", id: event.id, error: "Unknown browser operation" }));
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

// A userscript file in the temporary home, as Pi would write it.
function scriptFile(name: string, body = "document.title = 'changed';\n", extra: string[] = []) {
  const dir = mkdtempSync(join(homedir(), "scripts-"));
  const file = join(dir, `${name}.user.js`);
  writeFileSync(file, `// ==UserScript==\n// @name ${name}\n// @match https://*.example.test/*\n${extra.map(l => `// ${l}\n`).join("")}// ==/UserScript==\n${body}`);
  return file;
}

test("userscript installs into Chrome, reinstalling updates it, and list and uninstall manage it", async () => {
  const tools = await setup();
  const file = scriptFile("Dim ads");
  await tools.userscript.execute("install", { action: "install", file }, undefined);
  expect([...chromeFake.userScripts.values()]).toEqual([expect.objectContaining({ id: "Dim ads", matches: ["https://*.example.test/*"], world: "MAIN", js: [{ code: expect.stringContaining("document.title") }] })]);
  writeFileSync(file, readFileSync(file, "utf8").replace("changed", "edited"));
  await tools.userscript.execute("reinstall", { action: "install", file }, undefined);
  expect(chromeFake.userScripts.size).toBe(1);
  expect(chromeFake.userScripts.get("Dim ads").js[0].code).toContain("edited");
  expect((await tools.userscript.execute("list", { action: "list" }, undefined)).content[0].text).toContain("Dim ads");
  await tools.userscript.execute("uninstall", { action: "uninstall", name: "Dim ads" }, undefined);
  expect(chromeFake.userScripts.size).toBe(0);
  await expect(tools.userscript.execute("again", { action: "uninstall", name: "Dim ads" }, undefined)).rejects.toThrow("No installed userscript");
});

test("userscript tells the user how to allow user scripts when Chrome blocks them", async () => {
  const tools = await setup();
  chromeFake.userScriptsAllowed = false;
  await expect(tools.userscript.execute("install", { action: "install", file: scriptFile("Blocked") }, undefined)).rejects.toThrow("Allow User Scripts");
});

test("userscript test runs the script in a tab of its own and reports what it logged and threw", async () => {
  const tools = await setup();
  chromeFake.onDebuggerCommand = (method, params: any) => {
    if (method !== "Runtime.evaluate" || !params.expression.includes("document.title")) return;
    const tabId = chromeFake.tabs.at(-1)!.id;
    chromeFake.debuggerEvent.emit({ tabId }, "Runtime.consoleAPICalled", { type: "log", args: [{ type: "string", value: "hid 3 ads" }] });
    chromeFake.debuggerEvent.emit({ tabId }, "Runtime.exceptionThrown", { exceptionDetails: { text: "Uncaught", exception: { description: "TypeError: x is null" } } });
    return { result: { type: "undefined" } };
  };
  const result = await tools.userscript.execute("test", { action: "test", file: scriptFile("Dim ads"), url: "https://www.example.test/", wait: 0 }, undefined);
  expect(chromeFake.createdTabs.at(-1)).toMatchObject({ url: "https://www.example.test/", active: false });
  expect(result.content[0].text).toContain("hid 3 ads");
  expect(result.content[0].text).toContain("TypeError: x is null");
  // The test tab is closed, the user's tab is left alone.
  expect(chromeFake.tabs.map(t => t.id)).toEqual([42]);
  expect(chromeFake.userScripts.size).toBe(0);
  // A page the script would never run on is refused, rather than passing a test that means nothing.
  await expect(tools.userscript.execute("elsewhere", { action: "test", file: scriptFile("Dim ads"), url: "https://other.test/", wait: 0 }, undefined)).rejects.toThrow("doesn't run on");
});

test("reinstalling a script without a filter it used to have drops that filter", async () => {
  const tools = await setup();
  const file = scriptFile("Narrow", undefined, ["@exclude-match https://admin.example.test/*", "@noframes"]);
  await tools.userscript.execute("install", { action: "install", file }, undefined);
  writeFileSync(file, readFileSync(file, "utf8").replace(/\/\/ @exclude-match.*\n|\/\/ @noframes\n/g, ""));
  await tools.userscript.execute("reinstall", { action: "install", file }, undefined);
  const installed = chromeFake.userScripts.get("Narrow");
  expect(installed.excludeMatches ?? []).toEqual([]);
  expect(installed.allFrames).toBe(true);
});

test("an extension that wasn't reloaded after an update tells Pi to ask for a reload", async () => {
  const tools = await setup({ legacy: true });
  await expect(tools.userscript.execute("list", { action: "list" }, undefined)).rejects.toThrow("reload Ardi");
});
