// The bridge as the browser runs it: a process speaking Chrome's native
// messaging framing on stdin/stdout, running the fake pi. Any target's entry
// runs the shared host; Ardia's has no relay.
import { afterEach, expect, test } from "bun:test";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { FAKE_PI } from "../../support/executables";
import { waitFor } from "../../support/wait";
import { joinParts, type BridgeEvent, type BridgeRequest } from "../../../src/bridge/protocol";

const MAIN = resolve(import.meta.dirname, "../../../src/targets/ardia/bridge/main.ts");

let bridge: ChildProcessWithoutNullStreams;

afterEach(() => bridge.kill());

// One native message: a 4-byte little-endian length, then the JSON.
function frame(request: BridgeRequest): Buffer {
  const body = Buffer.from(JSON.stringify(request), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

// Starts the bridge and collects the events it sends, as the extension reads them.
function startBridge(): BridgeEvent[] {
  const events: BridgeEvent[] = [];
  const listen = joinParts((event) => events.push(event));
  bridge = spawn(process.execPath, [MAIN], { env: process.env });
  let buffer = Buffer.alloc(0);
  bridge.stdout.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32LE(0)) {
      const length = buffer.readUInt32LE(0);
      listen(JSON.parse(buffer.subarray(4, 4 + length).toString("utf8")));
      buffer = buffer.subarray(4 + length);
    }
  });
  return events;
}

test("reads framed requests however stdin splits them, answers in frames, and stops when the browser disconnects", async () => {
  const events = startBridge();
  const start = frame({ type: "start", piPath: FAKE_PI });
  // One message split across writes.
  bridge.stdin.write(start.subarray(0, 3));
  bridge.stdin.write(start.subarray(3));
  await waitFor(() => expect(events.map((e) => e.type)).toContain("ready"), 10_000);

  // Two messages in one write.
  bridge.stdin.write(Buffer.concat([frame({ type: "check_pi", piPath: FAKE_PI }), frame({ type: "prompt", text: "hi" })]));
  await waitFor(() => expect(events).toContainEqual({ type: "pi_check", command: FAKE_PI, version: "0.0.0-fake" }), 10_000);
  await waitFor(() => expect(events).toContainEqual({ type: "chunk", chunk: { type: "text", content: "echo: hi" } }), 10_000);

  const exited = new Promise<number | null>((done) => bridge.on("exit", done));
  bridge.stdin.end();
  expect(await exited).toBe(0);
});

test("a pi that doesn't exit when the browser disconnects is killed", async () => {
  const log = join(homedir(), "stuck-pi-launch.json");
  process.env.FAKE_PI_LAUNCH_LOG = log;
  process.env.FAKE_PI_IGNORE_EOF = "1";
  try {
    const events = startBridge();
    bridge.stdin.write(frame({ type: "start", piPath: FAKE_PI }));
    await waitFor(() => expect(events.map((e) => e.type)).toContain("ready"), 10_000);
    const { pid } = JSON.parse(readFileSync(log, "utf8")) as { pid: number };
    const exited = new Promise<number | null>((done) => bridge.on("exit", done));
    bridge.stdin.end();
    expect(await exited).toBe(0);
    await waitFor(() => expect(() => process.kill(pid, 0)).toThrow());
  } finally {
    delete process.env.FAKE_PI_LAUNCH_LOG;
    delete process.env.FAKE_PI_IGNORE_EOF;
  }
});

test("disconnecting while pi is still starting exits cleanly and stops pi", async () => {
  const log = join(homedir(), "starting-pi-launch.json");
  process.env.FAKE_PI_LAUNCH_LOG = log;
  process.env.FAKE_PI_STALL = "1";
  try {
    const events = startBridge();
    bridge.stdin.write(frame({ type: "start", piPath: FAKE_PI }));
    await waitFor(() => expect(existsSync(log)).toBe(true), 10_000);
    const { pid } = JSON.parse(readFileSync(log, "utf8")) as { pid: number };
    const exited = new Promise<number | null>((done) => bridge.on("exit", done));
    bridge.stdin.end();
    expect(await exited).toBe(0);
    expect(events.map((e) => e.type)).not.toContain("fatal");
    await waitFor(() => expect(() => process.kill(pid, 0)).toThrow());
  } finally {
    delete process.env.FAKE_PI_LAUNCH_LOG;
    delete process.env.FAKE_PI_STALL;
  }
});
