// Chrome native messaging framing on our stdin/stdout: each message is a
// 4-byte little-endian length + UTF-8 JSON. Nothing else may write to stdout.

import { toParts } from "../parts";
import type { BridgeEvent } from "./protocol";

// Chrome rejects host -> extension messages over 1 MB. A UTF-16 code unit is
// at most 3 UTF-8 bytes, so parts of this many characters stay well under.
const PART_CHARS = 256 * 1024;

// Set once the bridge is exiting: what was sent before still goes out, but
// nothing can be written after it (a notice behind the fatal error, say).
let closing = false;

// Sends an event, split into parts when it's too big for one message.
export function sendToExtension(event: BridgeEvent): void {
  for (const message of toParts(event, PART_CHARS)) write(JSON.stringify(message));
}

function write(json: string): void {
  if (closing) return;
  const body = Buffer.from(json, "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([header, body]));
}

// Exits once everything sent has reached the extension. process.exit alone
// drops output still queued for a reader that's behind.
export function exitAfterFlush(code: number): void {
  if (closing) return;
  closing = true;
  process.exitCode = code;
  process.stdout.end(() => process.exit(code));
}

export function onExtensionMessage(onMessage: (message: unknown) => void, onEnd: () => void): void {
  let buffer = Buffer.alloc(0);
  process.stdin.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0);
      if (buffer.length < 4 + length) break;
      const json = buffer.subarray(4, 4 + length).toString("utf8");
      buffer = buffer.subarray(4 + length);
      try {
        onMessage(JSON.parse(json));
      } catch (error) {
        console.error("bad message from extension:", error);
      }
    }
  });
  process.stdin.on("end", onEnd);
}
