import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";

import { PiRPCResponseError, PiRPCTransport, PiRPCTransportClosedError } from "../../../../src/bridge/runtime/PiRPCTransport";

// A transport wired to in-memory streams: `pi` is what pi writes, `sent`
// collects what the transport wrote to pi.
function connect() {
  const pi = new PassThrough();
  const toPi = new PassThrough();
  const sent: any[] = [];
  toPi.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString("utf8").split("\n").filter(Boolean)) sent.push(JSON.parse(line));
  });
  const transport = new PiRPCTransport({ input: pi, output: toPi });
  transport.start();
  const write = (record: unknown) => pi.write(`${JSON.stringify(record)}\n`);
  return { pi, sent, transport, write };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("PiRPCTransport", () => {
  test("matches responses to requests by id, whatever order they come back in", async () => {
    const { sent, transport, write } = connect();
    const state = transport.request("get_state");
    const models = transport.request("get_available_models");
    await tick();
    expect(sent.map((r) => r.type)).toEqual(["get_state", "get_available_models"]);
    write({ type: "response", id: sent[1].id, success: true, data: { models: [] } });
    write({ type: "response", id: sent[0].id, success: true, data: { sessionFile: "/s.jsonl" } });
    expect(await state).toEqual({ sessionFile: "/s.jsonl" });
    expect(await models).toEqual({ models: [] });
  });

  test("rejects a request pi answers with an error", async () => {
    const { sent, transport, write } = connect();
    const request = transport.request("set_model", { provider: "x", modelId: "y" });
    await tick();
    write({ type: "response", id: sent[0].id, success: false, error: "Unknown model" });
    await expect(request).rejects.toThrow(new PiRPCResponseError("set_model", "Unknown model"));
  });

  test("passes everything that isn't a response on as events, skipping junk lines", async () => {
    const { pi, transport } = connect();
    const events: unknown[] = [];
    transport.onEvent((event) => events.push(event));
    pi.write('{"type":"agent_start"}\nnot json\n[1,2]\n\n{"type":"agent_settled"}\n');
    await tick();
    expect(events).toEqual([{ type: "agent_start" }, { type: "agent_settled" }]);
  });

  test("fails pending requests when pi's output closes", async () => {
    const { pi, transport } = connect();
    const request = transport.request("get_state");
    pi.end();
    await expect(request).rejects.toBeInstanceOf(PiRPCTransportClosedError);
  });

  test("times out a request pi never answers", async () => {
    const { transport } = connect();
    await expect(transport.request("get_state", {}, 20)).rejects.toThrow("Request timeout: get_state");
  });
});
