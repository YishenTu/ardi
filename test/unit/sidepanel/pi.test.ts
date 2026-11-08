// The panel's side of its port to the background.
import { expect, spyOn, test } from "bun:test";

import { CHROME_MAX_MESSAGE_BYTES, chromeFake } from "../../support/chrome";
import { joinParts, toParts } from "../../../src/parts";
import type { ChatChunk } from "../../../src/chat";
import type { PanelRequest } from "../../../src/panel-protocol";
import { PiClient } from "../../../src/sidepanel/pi";
import { waitFor } from "../../support/wait";

const noop = () => undefined;

test("a prompt with an image bigger than one Chrome message reaches the background, and so does a big update back", async () => {
  const live: ChatChunk[] = [];
  const client = new PiClient({ replay: noop, model: noop, commands: noop, live: (chunk) => live.push(chunk), status: noop, sessions: noop, queue: noop, restore: noop });
  client.connect();
  const [port] = chromeFake.ports;

  const data = "A".repeat(CHROME_MAX_MESSAGE_BYTES + 1024);
  client.send({ kind: "prompt", text: "look", images: [{ data, mimeType: "image/png" }] });
  await waitFor(() => expect(port.sent.length).toBeGreaterThan(1));
  const requests: PanelRequest[] = [];
  port.sent.forEach(joinParts<PanelRequest>((request) => requests.push(request)));
  expect(requests).toHaveLength(1);
  expect(requests[0].kind === "prompt" && requests[0].images![0].data.length).toBe(data.length);

  const chunk: ChatChunk = { type: "user", text: "look", images: [{ data: "aGk=", mimeType: "image/png" }], at: 1 };
  for (const part of toParts({ kind: "live", chunk }, 8)) port.receive(part);
  expect(live).toEqual([chunk]);
});

test("requests go out in the order they were made, even while a prompt's images are still being read", async () => {
  const client = new PiClient({ replay: noop, model: noop, commands: noop, live: noop, status: noop, sessions: noop, queue: noop, restore: noop });
  client.connect();
  const [port] = chromeFake.ports;
  let read!: () => void;
  const images = new Promise<void>((resolve) => (read = resolve));

  client.send(images.then(() => ({ kind: "prompt", text: "first", images: [{ data: "aGk=", mimeType: "image/png" }] })));
  client.send({ kind: "prompt", text: "second" });
  client.send({ kind: "new_session" });
  read();
  await waitFor(() => expect(port.sent).toHaveLength(3));
  expect(port.sent.map((r: PanelRequest) => (r.kind === "prompt" ? r.text : r.kind))).toEqual(["first", "second", "new_session"]);
});

test("a prompt that ends up empty (its only image couldn't be read) isn't sent", async () => {
  const client = new PiClient({ replay: noop, model: noop, commands: noop, live: noop, status: noop, sessions: noop, queue: noop, restore: noop });
  client.connect();
  const [port] = chromeFake.ports;
  client.send(Promise.resolve(null));
  client.send({ kind: "abort" });
  await waitFor(() => expect(port.sent).toEqual([{ kind: "abort" }]));
});

test("stop goes at once, without waiting for a prompt still reading its images", () => {
  const client = new PiClient({ replay: noop, model: noop, commands: noop, live: noop, status: noop, sessions: noop, queue: noop, restore: noop });
  client.connect();
  const [port] = chromeFake.ports;
  client.send(new Promise<PanelRequest>(noop));
  client.send({ kind: "abort" });
  expect(port.sent).toEqual([{ kind: "abort" }]);
});

test("a request that fails to post doesn't stop the ones after it", async () => {
  const client = new PiClient({ replay: noop, model: noop, commands: noop, live: noop, status: noop, sessions: noop, queue: noop, restore: noop });
  client.connect();
  const [port] = chromeFake.ports;
  const post = port.postMessage.bind(port);
  let fail = true;
  port.postMessage = (message: unknown) => {
    if (fail) { fail = false; throw new Error("Attempting to use a disconnected port object"); }
    post(message);
  };
  const errors = spyOn(console, "error").mockImplementation(noop);
  client.send({ kind: "new_session" });
  client.send({ kind: "compact" });
  await waitFor(() => expect(port.sent).toEqual([{ kind: "compact" }]));
  errors.mockRestore();
});

test("a request made while the panel reconnects goes to the new connection", async () => {
  const client = new PiClient({ replay: noop, model: noop, commands: noop, live: noop, status: noop, sessions: noop, queue: noop, restore: noop });
  client.connect();
  chromeFake.ports[0].close();
  client.send({ kind: "new_session" });
  await waitFor(() => expect(chromeFake.ports[1]?.sent).toEqual([{ kind: "new_session" }]));
});
