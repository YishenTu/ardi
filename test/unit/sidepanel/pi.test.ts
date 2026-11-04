// The panel's side of its port to the background.
import { expect, test } from "bun:test";

import { CHROME_MAX_MESSAGE_BYTES, chromeFake } from "../../support/chrome";
import { joinParts, toParts } from "../../../src/parts";
import type { LiveItem, PanelRequest } from "../../../src/shared";
import { PiClient } from "../../../src/sidepanel/pi";

const noop = () => undefined;

test("a prompt with an image bigger than one Chrome message reaches the background, and so does a big update back", () => {
  const live: LiveItem[] = [];
  const client = new PiClient({ replay: noop, model: noop, commands: noop, live: (item) => live.push(item), status: noop, sessions: noop });
  client.connect();
  const [port] = chromeFake.ports;

  const data = "A".repeat(CHROME_MAX_MESSAGE_BYTES + 1024);
  client.send({ kind: "prompt", text: "look", images: [{ data, mimeType: "image/png" }] });
  const requests: PanelRequest[] = [];
  port.sent.forEach(joinParts<PanelRequest>((request) => requests.push(request)));
  expect(requests).toHaveLength(1);
  expect(requests[0].kind === "prompt" && requests[0].images![0].data.length).toBe(data.length);

  const item: LiveItem = { kind: "prompt", text: "look", images: [{ data: "aGk=", mimeType: "image/png" }], at: 1 };
  for (const part of toParts({ kind: "live", item }, 8)) port.receive(part);
  expect(live).toEqual([item]);
});
