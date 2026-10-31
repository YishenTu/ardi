import { afterEach, expect, test } from "bun:test";
import { ChromeBrowserRelay } from "../../../src/bridge/chrome-relay";
import type { BridgeEvent } from "../../../src/bridge/protocol";
import { waitFor } from "../../support/wait";

let relay: ChromeBrowserRelay;
afterEach(() => relay?.dispose());
function request(body: unknown, token: string = relay.token, signal?: AbortSignal) {
  return fetch(relay.url, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
}

test("only authenticated local tool requests are forwarded to the extension", async () => {
  const sent: BridgeEvent[] = [];
  relay = new ChromeBrowserRelay(event => sent.push(event));
  expect((await request({ op: "list" }, "wrong")).status).toBe(403);
  const origin = await fetch(relay.url, { method: "POST", headers: { Origin: "https://page.test", Authorization: `Bearer ${relay.token}` }, body: '{"op":"list"}' });
  expect(origin.status).toBe(403);
  expect(sent).toHaveLength(0);
  const pending = request({ op: "list" });
  await waitFor(() => expect(sent).toHaveLength(1));
  const event = sent[0] as Extract<BridgeEvent, { type: "browser_request" }>;
  relay.reply({ type: "browser_reply", id: event.id, result: [{ id: "42" }] });
  expect(await (await pending).json()).toEqual({ result: [{ id: "42" }] });
});

test("concurrent replies are correlated and browser errors reach the right caller", async () => {
  const sent: any[] = [];
  relay = new ChromeBrowserRelay(event => sent.push(event));
  const a = request({ op: "list" });
  const b = request({ op: "eval", id: "2", code: "1" });
  await waitFor(() => expect(sent).toHaveLength(2));
  const list = sent.find(e => e.request.op === "list");
  const evaluate = sent.find(e => e.request.op === "eval");
  relay.reply({ type: "browser_reply", id: evaluate.id, error: "User canceled" });
  relay.reply({ type: "browser_reply", id: list.id, result: [] });
  expect(await (await a).json()).toEqual({ result: [] });
  expect(await (await b).json()).toEqual({ error: "User canceled" });
});

test("lost browser replies time out and disconnection fails outstanding calls", async () => {
  relay = new ChromeBrowserRelay(() => {}, 30);
  expect(await (await request({ op: "list" })).json()).toEqual({ error: expect.stringContaining("timed out") });
  relay.dispose();
  const sent: any[] = [];
  relay = new ChromeBrowserRelay(e => sent.push(e));
  const pending = request({ op: "list" });
  await waitFor(() => expect(sent).toHaveLength(1));
  relay.dispose();
  expect(await (await pending).json()).toEqual({ error: expect.stringContaining("disconnected") });
});
