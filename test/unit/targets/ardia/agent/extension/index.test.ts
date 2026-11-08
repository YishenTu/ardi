import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { executable } from "../../../../../support/executables";
import register from "../../../../../../src/targets/ardia/agent/extension/index";

// The ardia CLI as the tools see it: `ardia browse` (agent-browser's commands,
// `--json` answers) and `ardia windows`. `ardia exec` is gone, as in the real
// CLI since 0.2.45, and fails the way it does there.
const FAKE_ARDIA = String.raw`
const fs = require("node:fs");
const argv = process.argv.slice(2);
const TABS = [
  { tabId: "t1", appTabId: "tab-a", title: "Page A", url: "https://a.test/", type: "page" },
  { tabId: "t2", appTabId: "tab-b", title: "Page B", url: "https://b.test/", type: "page" },
];
const tab = (t) => ({ tabId: t.tabId, title: t.title, url: t.url });
// Like the real CLI, a session that switched to a tab keeps using it until it
// ends, and another session can't close a tab one is using.
const USED = __dirname + "/used.json";
const used = () => (fs.existsSync(USED) ? JSON.parse(fs.readFileSync(USED, "utf8")) : {});
const session = process.env.AGENT_BROWSER_SESSION;
fs.appendFileSync(__dirname + "/calls.log", JSON.stringify({ session, argv }) + "\n");
function answer(line) {
  const [cmd, arg] = line;
  // t3 is a tab whose page breaks once you're on it.
  if (cmd === "eval" && used()[session] === "t3") throw new Error("Page crashed");
  if (cmd === "tab" && arg === "t3") { fs.writeFileSync(USED, JSON.stringify({ ...used(), [session]: arg })); return { tabId: "t3", title: "Broken", url: "https://c.test/" }; }
  if (cmd === "tab" && arg === "list") return { tabs: TABS };
  if (cmd === "tab" && arg === "active") return tab(TABS[1]);
  if (cmd === "tab" && arg !== "close") fs.writeFileSync(USED, JSON.stringify({ ...used(), [session]: arg }));
  if (cmd === "tab") return tab(TABS.find((t) => t.tabId === arg));
  if (cmd === "eval") return { result: "Text of the page" };
  throw new Error("unexpected " + cmd);
}
if (argv[0] === "windows") {
  console.log(JSON.stringify([{ focused: false, tabs: [{ id: "tab-a", active: true }] }, { focused: true, tabs: [{ id: "tab-a", active: false }, { id: "tab-b", active: true }] }]));
} else if (argv[0] === "browse" && argv[1] === "batch") {
  const lines = fs.readFileSync(0, "utf8").split("\n").filter(Boolean);
  if (process.env.FAKE_ARDIA_BUSY) {
    // Errors outside any one command (daemon start, a busy session) aren't per line.
    console.log(JSON.stringify({ success: false, data: null, error: "session_busy: another command is running" }));
    process.exit(1);
  } else if (argv.includes("--json")) {
    // --bail: the first failure stops the rest, a last close included.
    const steps = [];
    for (const command of lines.map((l) => JSON.parse(l))) {
      if (steps.some((s) => !s.success)) { steps.push({ command, success: false, result: null, error: "not_run" }); continue; }
      if (command[0] === "close") { fs.writeFileSync(USED, JSON.stringify({ ...used(), [session]: undefined })); steps.push({ command, success: true, result: { closed: true }, error: null }); continue; }
      try { steps.push({ command, success: true, result: answer(command), error: null }); }
      catch (e) { steps.push({ command, success: false, result: null, error: e.message }); }
    }
    console.log(JSON.stringify(steps));
    process.exit(steps.every((s) => s.success) ? 0 : 1);
  } else if (lines[0]?.startsWith("tab close ")) {
    const id = lines[0].split(" ")[2];
    const other = Object.entries(used()).find(([s, t]) => s !== session && t === id);
    console.log(other ? "✗ Tab [" + id + "] is in use by session " + other[0] + ", so it stays open" : "✓ Closed " + id);
    process.exit(other ? 1 : 0);
  } else if (lines.some((l) => l.startsWith("click @e404"))) {
    console.log("✗ click @e404: Element not found");
    process.exit(1);
  } else {
    console.log(lines.map((l) => "✓ " + l).join("\n"));
  }
} else if (argv[0] === "browse" && argv[1] === "script") {
  // Answers without reading its input, as a CLI that fails early or is cancelled does.
  console.log("ran");
} else if (argv[0] === "browse" && argv[1] === "close") {
  fs.writeFileSync(USED, JSON.stringify({ ...used(), [session]: undefined }));
  console.log(JSON.stringify({ success: true, data: { closed: true }, error: null }));
} else {
  console.error("ardia: unknown command '" + argv[0] + "': it was removed. Drive the browser with ardia browse.");
  process.exit(2);
}
`;

type Tool = { name: string; execute: (id: string, params: object, signal?: AbortSignal, onUpdate?: unknown, ctx?: unknown) => Promise<{ content: { type: string; text?: string }[]; details?: unknown }> };

const path = process.env.PATH;
let tools: Record<string, Tool>;
let bin: string;
const chat = (id: string) => ({ sessionManager: { getSessionId: () => id } });
const calls = () => readFileSync(join(bin, "calls.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { session: string; argv: string[] });

beforeEach(() => {
  bin = mkdtempSync(join(tmpdir(), "ardi-fake-ardia-"));
  executable("ardia", FAKE_ARDIA, bin);
  process.env.PATH = `${bin}${delimiter}${path}`;
  tools = {};
  register({ on() {}, registerTool: (tool: Tool) => (tools[tool.name] = tool) } as never);
});

afterEach(() => { process.env.PATH = path; delete process.env.FAKE_ARDIA_BUSY; });

const textOf = (result: Awaited<ReturnType<Tool["execute"]>>) => result.content.map((c) => c.text).join("");

test("list_tabs lists the user's tabs and marks the one they're looking at in the focused window", async () => {
  const result = await tools.list_tabs.execute("1", {});
  expect(result.details).toEqual([
    { id: "t1", title: "Page A", url: "https://a.test/", current: false },
    { id: "t2", title: "Page B", url: "https://b.test/", current: true },
  ]);
  expect(textOf(result)).toContain("* t2  Page B");
});

test("read_tab reads the user's current tab by default, a mentioned tab by URL, with the title and URL first", async () => {
  expect(textOf(await tools.read_tab.execute("1", {}))).toBe("Page B\nhttps://b.test/\n\nText of the page");
  const byUrl = await tools.read_tab.execute("2", { url: "https://a.test/" });
  expect(textOf(byUrl)).toStartWith("Page A\nhttps://a.test/\n\n");
  expect(byUrl.details).toMatchObject({ id: "t1" });
});

// The read-only tools switch tabs in a session of their own; a tab they read
// must stay one the agent can close.
test("a tab the agent read can still be closed by the agent", async () => {
  await tools.read_tab.execute("1", { id: "t1" });
  expect(textOf(await tools.ardia_exec.execute("2", { code: "tab close t1" }))).toBe("✓ Closed t1");
});

test("a read that fails still leaves the tab one the agent can close", async () => {
  await expect(tools.read_tab.execute("1", { id: "t3" })).rejects.toThrow("Page crashed");
  expect(textOf(await tools.ardia_exec.execute("2", { code: "tab close t3" }))).toBe("✓ Closed t3");
});

// A Pi session is one chat. A chat must not act on, or close, the tabs another chat opened.
test("each chat drives the browser in its own session", async () => {
  await tools.ardia_exec.execute("1", { code: "snapshot -i" }, undefined, undefined, chat("chat-a"));
  await tools.ardia_exec.execute("2", { code: "snapshot -i" }, undefined, undefined, chat("chat-a"));
  await tools.ardia_exec.execute("3", { code: "snapshot -i" }, undefined, undefined, chat("chat-b"));
  const [a1, a2, b] = calls().map((c) => c.session);
  expect(a1).toBe(a2);
  expect(b).not.toBe(a1);
});

test("an error from the CLI itself reaches the agent as it is", async () => {
  process.env.FAKE_ARDIA_BUSY = "1";
  await expect(tools.read_tab.execute("1", {})).rejects.toThrow("session_busy: another command is running");
});

// Pi runs the tools in its own process: a CLI that stops reading its input
// (it failed early, or the call was cancelled) must not take Pi down.
test("a CLI that exits before reading a long script doesn't crash Pi", async () => {
  const crashes: unknown[] = [];
  const crashed = (error: unknown) => crashes.push(error);
  process.on("uncaughtException", crashed);
  try {
    expect(textOf(await tools.ardia_exec.execute("1", { code: "x".repeat(4 * 1024 * 1024), script: true }))).toBe("ran");
    await Bun.sleep(50);
  } finally {
    process.off("uncaughtException", crashed);
  }
  expect(crashes).toEqual([]);
});

test("ardia_exec runs its commands in the browser and reports a failed one as an error", async () => {
  expect(textOf(await tools.ardia_exec.execute("1", { code: "snapshot -i\nclick @e3" }))).toBe("✓ snapshot -i\n✓ click @e3");
  await expect(tools.ardia_exec.execute("2", { code: "click @e404" })).rejects.toThrow("Element not found");
});
