import { expect, test } from "bun:test";

import type { BridgeEvent } from "../../../src/bridge/protocol";
import { PiInput } from "../../../src/bridge/PiInput";
import type { PiRPCTransport } from "../../../src/bridge/runtime/PiRPCTransport";

test("a run that starts and settles before pi's answer to its prompt is read leaves pi idle", async () => {
  const events: BridgeEvent[] = [];
  const input = new PiInput((event) => events.push(event));
  let answer!: (data: unknown) => void;
  // pi's reply, agent_start and agent_settled arrive in one read: the
  // transport hands over the reply in order, but the request's continuation
  // runs only after all three were handled.
  const transport = {
    request: (_type: string, _payload: unknown, _timeout: number, onAnswer?: (data: unknown) => void) =>
      new Promise((resolve) => (answer = (data) => { onAnswer?.(data); resolve(data); })),
  } as unknown as PiRPCTransport;
  input.connect(transport);
  const sending = input.prompt("hi", { promptId: "p1" });
  await Promise.resolve();
  answer({ disposition: "started" });
  input.observe({ type: "agent_start" });
  input.observe({ type: "agent_settled", aborted: false });
  await sending;
  expect(events.filter((e) => e.type === "busy").at(-1)).toMatchObject({ type: "busy", busy: false });
});

test("a stop stays busy until it has handed pi's queue back, even when the run settles meanwhile", async () => {
  const events: BridgeEvent[] = [];
  const input = new PiInput((event) => events.push(event));
  let cleared!: (data: unknown) => void;
  const transport = {
    request: (type: string) => (type === "clear_queue" ? new Promise((resolve) => (cleared = resolve)) : Promise.resolve({})),
  } as unknown as PiRPCTransport;
  input.connect(transport);
  input.observe({ type: "agent_start" });
  input.observe({ type: "queue_update", steering: [], followUp: ["first"] });
  const stopping = input.stop();
  await Promise.resolve();
  // pi ends the run before it answers clear_queue.
  input.observe({ type: "queue_update", steering: [], followUp: [] });
  input.observe({ type: "agent_settled", aborted: true });
  expect(events).not.toContainEqual({ type: "busy", busy: false });
  cleared({ steering: [], followUp: ["first"] });
  await stopping;
  const back = events.findIndex((e) => e.type === "restore");
  expect(events[back]).toEqual({ type: "restore", text: "first" });
  expect(events.findLastIndex((e) => e.type === "busy" && !e.busy)).toBeGreaterThan(back);
});
