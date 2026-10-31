// Chrome's bridge as the browser runs it, with the fake pi calling the relay
// the way Chrome's browser tools do.
import { afterEach, expect, test } from "bun:test";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { resolve } from "node:path";

import { FAKE_PI } from "../../../../support/executables";
import { waitFor } from "../../../../support/wait";
import { joinParts, type BridgeEvent, type BridgeRequest } from "../../../../../src/bridge/protocol";

const MAIN = resolve(import.meta.dirname, "../../../../../src/targets/chrome/bridge/main.ts");

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

test("Pi browser requests travel over native messaging and receive the extension's result", async () => {
  const events = startBridge();
  bridge.stdin.write(frame({ type: "start", piPath: FAKE_PI }));
  await waitFor(() => expect(events.map(e => e.type)).toContain("ready"));
  bridge.stdin.write(frame({ type: "prompt", text: "browser:list" }));
  await waitFor(() => expect(events.some(e => e.type === "browser_request")).toBe(true));
  const request = events.find(e => e.type === "browser_request")!;
  if (request.type !== "browser_request") throw new Error("Missing browser request");
  expect(request.request).toEqual({ op: "list" });
  bridge.stdin.write(frame({ type: "browser_reply", id: request.id, result: [{ id: "123", title: "User's existing tab" }] }));
  await waitFor(() => expect(events).toContainEqual({ type: "chunk", chunk: { type: "text", content: 'echo: [{"id":"123","title":"User\'s existing tab"}]' } }));
});
