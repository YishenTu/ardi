import { describe, expect, test } from "bun:test";

import type { ChatChunk } from "../../../../src/chat";
import { createPiEventNormalizationState, normalizePiRPCEvent } from "../../../../src/bridge/normalization/piEventNormalization";

// Feeds pi events through one normalization state, as a run would.
function normalize(...events: Record<string, unknown>[]): ChatChunk[] {
  const state = createPiEventNormalizationState();
  return events.flatMap((event) => normalizePiRPCEvent(event, state));
}

describe("runs", () => {
  test("a run starts with agent_start and ends only when pi settles", () => {
    expect(normalize({ type: "agent_start" }, { type: "agent_end" }, { type: "agent_settled" })).toEqual([
      { type: "run_start", at: expect.any(Number) },
      { type: "run_end", at: expect.any(Number), interrupted: false },
    ]);
  });

  test("an aborted run ends as interrupted", () => {
    expect(normalize({ type: "agent_settled", aborted: true })).toEqual([{ type: "run_end", at: expect.any(Number), interrupted: true }]);
  });
});

describe("assistant messages", () => {
  test("streams text and thinking deltas", () => {
    expect(
      normalize(
        { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "hmm" } },
        { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Hi" } },
        { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "" } },
        { type: "message_update", assistantMessageEvent: { type: "toolcall_delta", delta: "{" } },
      ),
    ).toEqual([
      { type: "thinking", content: "hmm" },
      { type: "text", content: "Hi" },
    ]);
  });

  test("reports output tokens of each assistant reply", () => {
    expect(
      normalize(
        { type: "message_end", message: { role: "assistant", usage: { output: 42 } } },
        { type: "message_end", message: { role: "assistant", usage: { output: 0 } } },
        { type: "message_end", message: { role: "user", usage: { output: 5 } } },
      ),
    ).toEqual([{ type: "usage", outputTokens: 42 }]);
  });

  test("a reply that stopped on an error becomes one error notice", () => {
    // pi reports the failed reply in message_end, then again in turn_end.
    const failed = { role: "assistant", stopReason: "error", errorMessage: "Rate limited" };
    expect(normalize({ type: "message_end", message: failed }, { type: "turn_end", message: failed, toolResults: [] })).toEqual([
      { type: "notice", content: "Rate limited", level: "error" },
    ]);
    expect(normalize({ type: "message_end", message: { role: "assistant", stopReason: "error" } })).toEqual([{ type: "notice", content: "Pi turn failed.", level: "error" }]);
  });

  test("shows extension messages unless they ask not to be displayed", () => {
    expect(
      normalize(
        { type: "message_start", message: { role: "custom", content: [{ type: "text", text: "Hello " }, { type: "text", text: "there" }] } },
        { type: "message_start", message: { role: "custom", content: "hidden", display: false } },
        { type: "message_start", message: { role: "user", content: "not custom" } },
      ),
    ).toEqual([{ type: "notice", content: "Hello there", level: "info" }]);
  });
});

describe("tools", () => {
  test("a tool call is reported once, with its input", () => {
    const start = { type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "ls" } };
    expect(normalize(start, start)).toEqual([{ type: "tool_use", id: "t1", name: "bash", input: { command: "ls" } }]);
  });

  test("partial results stream as appended output", () => {
    const update = (text: string) => ({ type: "tool_execution_update", toolCallId: "t1", partialResult: { content: [{ type: "text", text }] } });
    expect(normalize(update("a"), update("ab"), update("abc"))).toEqual([
      { type: "tool_output", id: "t1", content: "a" },
      { type: "tool_output", id: "t1", content: "b" },
      { type: "tool_output", id: "t1", content: "c" },
    ]);
  });

  test("once a snapshot stops extending the output, streaming waits for the result", () => {
    const update = (text: string) => ({ type: "tool_execution_update", toolCallId: "t1", partialResult: { content: [{ type: "text", text }] } });
    const end = { type: "tool_execution_end", toolCallId: "t1", toolName: "bash", result: { content: [{ type: "text", text: "final" }] } };
    expect(normalize(update("abc"), update("xyz"), update("xyz!"), end)).toEqual([
      { type: "tool_output", id: "t1", content: "abc" },
      { type: "tool_result", id: "t1", content: "final", isError: false, details: undefined },
    ]);
  });

  test("the result carries pi's details and error flag", () => {
    const end = { type: "tool_execution_end", toolCallId: "t1", toolName: "read_tab", isError: true, result: { content: [{ type: "text", text: "boom" }], details: { title: "T" } } };
    expect(normalize(end)).toEqual([{ type: "tool_result", id: "t1", content: "boom", isError: true, details: { title: "T" } }]);
  });

  test("a codemode result drops pi's run header", () => {
    const end = {
      type: "tool_execution_end",
      toolCallId: "t1",
      toolName: "codemode",
      result: { content: [{ type: "text", text: "Script completed\nWall time 0.12 seconds\nOutput:\n" }, { type: "text", text: "42" }] },
    };
    expect(normalize(end)).toMatchObject([{ type: "tool_result", content: "42" }]);
  });

  test("calls made inside a running tool are left out", () => {
    expect(normalize({ type: "tool_execution_start", toolCallId: "inner", toolName: "bash", parentToolCallId: "outer" })).toEqual([]);
  });
});
