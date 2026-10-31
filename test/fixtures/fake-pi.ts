#!/usr/bin/env node
// A stand-in for `pi --mode rpc`, for bridge tests. Speaks pi's RPC JSONL
// (one command per line in, responses and events out) and saves sessions
// in pi's session file format, so resuming reads real history. Event and
// response shapes follow pi's docs (docs/json.md, docs/rpc-commands.md).
//
// FAKE_PI_WRONG_SESSION=1 makes it report a session other than the one it
// was asked to open. FAKE_PI_IGNORE_EOF=1 makes it keep running after its
// stdin closes, like a pi stuck in a tool call. FAKE_PI_STALL=1 makes it
// never answer, like a pi still starting up.

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
if (process.env.FAKE_PI_LAUNCH_LOG) writeFileSync(process.env.FAKE_PI_LAUNCH_LOG, JSON.stringify({
  args, cwd: process.cwd(), relay: Boolean(process.env.ARDI_BROWSER_URL), pid: process.pid,
}));
if (args.includes("--version")) {
  console.log("0.0.0-fake");
  process.exit(0);
}

const sessionsDir = join(process.env.HOME!, "fake-pi-sessions");
mkdirSync(sessionsDir, { recursive: true });
let nextSession = 0;
// Like pi, a new session gets a path but no file until its first message.
const newSessionFile = () => join(sessionsDir, `${process.pid}-${nextSession++}.jsonl`);

const flag = args.indexOf("--session");
// Like pi, it exits when asked to resume a session that was never saved.
if (flag >= 0 && !existsSync(args[flag + 1])) {
  console.error(`No session found at ${args[flag + 1]}`);
  process.exit(1);
}
let sessionFile = flag >= 0 ? args[flag + 1] : newSessionFile();
let lastId: string | null = null;
let model = { provider: "fake", id: "m1" };
let thinkingLevel = "medium";

const send = (record: unknown) => process.stdout.write(`${JSON.stringify(record)}\n`);

function save(message: Record<string, unknown>) {
  if (!existsSync(sessionFile)) writeFileSync(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: "s", timestamp: new Date().toISOString(), cwd: process.cwd() })}\n`);
  const id = Math.random().toString(16).slice(2, 10);
  appendFileSync(sessionFile, `${JSON.stringify({ type: "message", id, parentId: lastId, timestamp: new Date().toISOString(), message })}\n`);
  lastId = id;
}

function handle(command: Record<string, any>): unknown {
  switch (command.type) {
    case "get_available_models":
      return { models: [{ provider: "fake", id: "m1", name: "Model One", reasoning: true }, { provider: "fake", id: "m2", reasoning: false }] };
    case "get_commands":
      return { commands: [{ name: "skill:demo", description: "A demo skill", source: "skill" }] };
    case "get_state":
      return { sessionFile: process.env.FAKE_PI_WRONG_SESSION ? join(sessionsDir, "other.jsonl") : sessionFile, model, thinkingLevel };
    case "switch_session":
      sessionFile = command.sessionPath;
      lastId = null;
      return { cancelled: false };
    case "new_session":
      sessionFile = newSessionFile();
      lastId = null;
      return { cancelled: false };
    case "set_model":
      model = { provider: command.provider, id: command.modelId };
      thinkingLevel = command.modelId === "m2" ? "off" : thinkingLevel;
      return {};
    case "set_thinking_level":
      thinkingLevel = command.level;
      return {};
    case "prompt":
      if (command.message === "handled:command") return { disposition: "handled" };
      // Answers once the prompt is accepted; the run streams as events.
      queueMicrotask(() => void run(command.message));
      return { disposition: "started" };
    default:
      return {};
  }
}

// Echoes the prompt back as the reply, with pi's full event sequence for a
// one-turn run.
async function run(text: string) {
  if (text === "browser:list") {
    const response = await fetch(process.env.ARDI_BROWSER_URL!, {
      method: "POST", headers: { Authorization: `Bearer ${process.env.ARDI_BROWSER_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ op: "list" }),
    });
    const reply = await response.json() as { result: unknown };
    text = JSON.stringify(reply.result);
  }
  const reply = `echo: ${text}`;
  const user = { role: "user", content: text, timestamp: Date.now() };
  save(user);
  send({ type: "agent_start" });
  send({ type: "turn_start" });
  send({ type: "message_start", message: user });
  send({ type: "message_end", message: user });
  send({ type: "message_start", message: { role: "assistant", content: [], stopReason: "pending" } });
  send({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: reply } });
  const message = { role: "assistant", content: [{ type: "text", text: reply }], usage: { output: 3 }, stopReason: "stop", timestamp: Date.now() };
  save(message);
  send({ type: "message_end", message });
  send({ type: "turn_end", message, toolResults: [] });
  send({ type: "agent_end", messages: [user, message], willRetry: false });
  send({ type: "agent_settled" });
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
    const command = JSON.parse(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
    if (process.env.FAKE_PI_STALL) continue;
    if (command.type === "prompt" && command.message === "reject:busy") {
      send({ type: "response", id: command.id, command: command.type, success: false, error: "Agent is already streaming. Specify streamingBehavior to queue a message." });
    } else send({ type: "response", id: command.id, command: command.type, success: true, data: handle(command) });
  }
});
process.stdin.on("end", () => {
  if (process.env.FAKE_PI_IGNORE_EOF) setInterval(() => undefined, 1_000);
  else process.exit(0);
});
