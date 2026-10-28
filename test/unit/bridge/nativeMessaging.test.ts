import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import { sendToExtension } from "../../../src/bridge/nativeMessaging";
import { joinParts, type BridgeEvent, type BridgePart } from "../../../src/bridge/protocol";

// Chrome's limit for one host -> extension message.
const CHROME_MAX_BYTES = 1024 * 1024;

let frames: Buffer[];
let writeSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  frames = [];
  writeSpy = spyOn(process.stdout, "write").mockImplementation((data: Buffer) => {
    frames.push(Buffer.from(data));
    return true;
  });
});

afterEach(() => writeSpy.mockRestore());

// What the extension sees: each frame's JSON, after the 4-byte length.
function messages(): (BridgeEvent | BridgePart)[] {
  return frames.map((frame) => {
    expect(frame.readUInt32LE(0)).toBe(frame.length - 4);
    return JSON.parse(frame.subarray(4).toString("utf8"));
  });
}

function received(): BridgeEvent[] {
  const events: BridgeEvent[] = [];
  const listen = joinParts((event) => events.push(event));
  for (const message of messages()) listen(message);
  return events;
}

describe("sendToExtension", () => {
  test("sends a small event as one length-prefixed message", () => {
    const event: BridgeEvent = { type: "fatal", message: "pi exited" };
    sendToExtension(event);
    expect(messages()).toEqual([event]);
  });

  test("splits an event over Chrome's 1 MB limit into parts that join back", () => {
    const event: BridgeEvent = { type: "fatal", message: "é漢x😀\n\"".repeat(400_000) };
    sendToExtension(event);
    expect(frames.length).toBeGreaterThan(1);
    for (const frame of frames) expect(frame.length).toBeLessThan(CHROME_MAX_BYTES);
    expect(received()).toEqual([event]);
  });

  // Joining parts here would repair a split pair either way, but Chrome's own
  // JSON parser doesn't accept the lone surrogate a split part would carry.
  test("never ends a part in the middle of an emoji", () => {
    // Offsets the emoji so a plain fixed-size cut would land inside one.
    for (const pad of ["", "a", "ab", "abc"]) {
      frames = [];
      sendToExtension({ type: "fatal", message: pad + "😀".repeat(300_000) });
      for (const message of messages()) {
        if (message.type !== "part") continue;
        const last = message.data.charCodeAt(message.data.length - 1);
        expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
      }
    }
  });

  test("keeps events in order when big and small ones mix", () => {
    const big: BridgeEvent = { type: "fatal", message: "x".repeat(600_000) };
    const small: BridgeEvent = { type: "chunk", chunk: { type: "text", content: "hi" } };
    sendToExtension(small);
    sendToExtension(big);
    sendToExtension(small);
    expect(received()).toEqual([small, big, small]);
  });
});
