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
//
// A run for the prompt "hold" waits after its reply until a steering
// message arrives or it is aborted; "hold-till-clear" waits until the queue
// is cleared or it is aborted. Messages sent meanwhile queue like pi's (steering, then
// follow-ups once the run would stop); like pi, it takes one by dropping it
// from the queue (queue_update) and then starting it as a user message, and
// an abort still delivers what is left in the queue. Races pi can produce:
// a queued "eager:" message is taken before pi answers, and a "slip:" one is
// taken just before a clear_queue. Like pi, it expands "/skill:demo X" to
// "expanded demo: X", and an image-only message it takes stays listed in its
// queue (pi drops taken messages by text).

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

type Queued = { text: string; images?: Record<string, unknown>[] };
let running = false;
let aborted = false;
let steering: Queued[] = [];
let followUp: Queued[] = [];
// Wakes a held run.
let wake: (() => void) | null = null;
let holding = "";
// Image-only messages taken but still listed, per queue.
let staleSteering = 0;
let staleFollowUp = 0;

const expand = (text: string) => text.replace(/^\/skill:demo (.*)$/s, "expanded demo: $1");

const send = (record: unknown) => process.stdout.write(`${JSON.stringify(record)}\n`);

function save(message: Record<string, unknown>) {
  if (!existsSync(sessionFile)) writeFileSync(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: "s", timestamp: new Date().toISOString(), cwd: process.cwd() })}\n`);
  const id = Math.random().toString(16).slice(2, 10);
  appendFileSync(sessionFile, `${JSON.stringify({ type: "message", id, parentId: lastId, timestamp: new Date().toISOString(), message })}\n`);
  lastId = id;
}

function handle(command: Record<string, any>): unknown {
  if (typeof command.message === "string") command.message = expand(command.message);
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
      if (running) {
        if (!command.streamingBehavior) throw new Error("Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.");
        const queued = enqueue(command.streamingBehavior === "steer", command);
        if (command.message.startsWith("eager:")) take(command.message);
        return queued;
      }
      // Answers once the prompt is accepted; the run streams as events.
      queueMicrotask(() => void run(command.message, command.images));
      return { disposition: "started" };
    case "steer":
    case "follow_up":
      return enqueue(command.type === "steer", command);
    case "clear_queue": {
      const slip = [...steering, ...followUp].find((q) => q.text.startsWith("slip:"));
      if (slip) take(slip.text);
      const cleared = listed();
      steering = [];
      followUp = [];
      staleSteering = 0;
      staleFollowUp = 0;
      queueUpdate();
      if (holding === "hold-till-clear") wake?.();
      return cleared;
    }
    case "abort":
      if (running) aborted = true;
      wake?.();
      return {};
    default:
      return {};
  }
}

function enqueue(steer: boolean, command: Record<string, any>) {
  (steer ? steering : followUp).push({ text: command.message, images: command.images });
  queueUpdate();
  if (steer && holding === "hold") wake?.();
  return { disposition: "queued" };
}

// Delivers a queued message now, mid-run.
function take(text: string) {
  const message = [...steering, ...followUp].find((q) => q.text === text)!;
  void turn(message.text, message.images, message);
}

// Like pi, drops a message it takes from the queue just before starting it
// (the first with its text).
function dequeue(message: Queued) {
  if (!message.text) {
    if (steering.includes(message)) staleSteering++;
    else staleFollowUp++;
  }
  steering = steering.filter((q) => q !== message);
  followUp = followUp.filter((q) => q !== message);
  queueUpdate();
}

function listed() {
  const empty = (n: number) => Array<string>(n).fill("");
  return { steering: [...empty(staleSteering), ...steering.map((q) => q.text)], followUp: [...empty(staleFollowUp), ...followUp.map((q) => q.text)] };
}

function queueUpdate() {
  send({ type: "queue_update", ...listed() });
}

// A run: one turn for the prompt, then one per queued message.
async function run(text: string, images?: Record<string, unknown>[]) {
  running = true;
  aborted = false;
  send({ type: "agent_start" });
  let next: Queued | undefined = { text, images };
  let queued: Queued | undefined;
  while (next) {
    await turn(next.text, next.images, queued);
    if (next.text.startsWith("hold") && !aborted && !steering.length) {
      holding = next.text;
      await new Promise<void>((resolve) => (wake = resolve));
    }
    wake = null;
    holding = "";
    next = steering[0] ?? followUp[0];
    queued = next;
  }
  running = false;
  send({ type: "agent_settled", aborted });
}

// Echoes the message back as the reply, with pi's event sequence for a turn.
// `queued`: the message pi takes from its queue.
async function turn(text: string, images?: Record<string, unknown>[], queued?: Queued) {
  if (text === "browser:list") {
    const response = await fetch(process.env.ARDI_BROWSER_URL!, {
      method: "POST", headers: { Authorization: `Bearer ${process.env.ARDI_BROWSER_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ op: "list" }),
    });
    const reply = await response.json() as { result: unknown };
    text = JSON.stringify(reply.result);
  }
  const reply = `echo: ${text}`;
  const user = { role: "user", content: images ? [{ type: "text", text }, ...images] : text, timestamp: Date.now() };
  save(user);
  send({ type: "turn_start" });
  if (queued) dequeue(queued);
  send({ type: "message_start", message: user });
  send({ type: "message_end", message: user });
  send({ type: "message_start", message: { role: "assistant", content: [], stopReason: "pending" } });
  send({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: reply } });
  const message = { role: "assistant", content: [{ type: "text", text: reply }], usage: { output: 3 }, stopReason: "stop", timestamp: Date.now() };
  save(message);
  send({ type: "message_end", message });
  send({ type: "turn_end", message, toolResults: [] });
  send({ type: "agent_end", messages: [user, message], willRetry: false });
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
    const command = JSON.parse(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
    if (process.env.FAKE_PI_STALL) continue;
    try {
      if (command.type === "prompt" && command.message === "reject:busy") throw new Error("Agent is already streaming. Specify streamingBehavior to queue a message.");
      send({ type: "response", id: command.id, command: command.type, success: true, data: handle(command) });
    } catch (error) {
      send({ type: "response", id: command.id, command: command.type, success: false, error: (error as Error).message });
    }
  }
});
process.stdin.on("end", () => {
  if (process.env.FAKE_PI_IGNORE_EOF) setInterval(() => undefined, 1_000);
  else process.exit(0);
});
