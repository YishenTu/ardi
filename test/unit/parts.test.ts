import { expect, test } from "bun:test";

import { joinParts, toParts } from "../../src/parts";

test("a message too big for one post goes as parts that join back, never splitting a character", () => {
  const message = { kind: "live", text: "👋".repeat(50) + "x".repeat(37) };
  const posted = toParts(message, 16);
  expect(posted.length).toBeGreaterThan(1);
  for (const part of posted) expect(JSON.stringify(part).length).toBeLessThan(16 + 60);
  const received: unknown[] = [];
  posted.forEach(joinParts((m) => received.push(m)));
  expect(received).toEqual([message]);
});

test("a small message goes as itself", () => {
  const message = { kind: "status", status: "connected" };
  expect(toParts(message, 1024)).toEqual([message]);
});
