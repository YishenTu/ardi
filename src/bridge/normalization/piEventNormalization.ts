// Adapted from Claudian (src/providers/pi/normalization/piEventNormalization.ts).
// Maps pi RPC events to Ardi chat chunks. Adds run_start/run_end; custom
// messages, compaction and retries become notices.
// Tool results carry pi's raw `details`; the panel's ToolCard reads them.
// Reads the event shapes in pi's docs (docs/json.md), not Claudian's
// fallbacks for other spellings.

import type { ChatChunk } from "../../chat";
import { extractPiToolResultText, extractPiToolTextContent, getRecord, getString, isPlainObject, normalizePiToolInput } from "./piToolNormalization";

export interface PiEventNormalizationState {
  emittedToolIds: Set<string>;
  /** Latest native partial-result snapshot per running tool. */
  toolOutputs: Map<string, string>;
  /** Running tools whose snapshot stopped extending the text already streamed. */
  divergedToolOutputIds: Set<string>;
}

export function createPiEventNormalizationState(): PiEventNormalizationState {
  return { divergedToolOutputIds: new Set(), emittedToolIds: new Set(), toolOutputs: new Map() };
}

export function normalizePiRPCEvent(event: Record<string, unknown>, state: PiEventNormalizationState): ChatChunk[] {
  switch (event.type) {
    // agent_end can be followed by retries or queued work; agent_settled means pi is done.
    case "agent_start":
      return [{ type: "run_start", at: Date.now() }];
    case "agent_settled":
      return [{ type: "run_end", at: Date.now(), interrupted: event.aborted === true }];
    case "message_update":
      return normalizeMessageUpdate(event);
    // Calls a tool makes while it runs (codemode scripts) never reach the model;
    // the calling tool's result summarizes them.
    case "tool_execution_start":
      return isNested(event) ? [] : normalizeToolUse(event, state);
    case "tool_execution_update":
      return isNested(event) ? [] : normalizeToolOutput(event, state);
    case "tool_execution_end":
      return isNested(event) ? [] : normalizeToolResult(event, state);
    case "message_start":
      return normalizeCustomMessage(event);
    // turn_end repeats the reply message_end already reported.
    case "message_end":
      return normalizeReplyEnd(event);
    case "compaction_start":
      return [{ type: "notice", content: "Compacting context…", level: "info" }];
    case "compaction_end": {
      if (event.aborted === true) return [];
      const errorMessage = getString(event.errorMessage);
      return [errorMessage ? { type: "notice", content: errorMessage, level: "warning" } : { type: "notice", content: "Context compacted.", level: "info" }];
    }
    case "auto_retry_start":
      return [{ type: "notice", content: "Pi is retrying the turn.", level: "warning" }];
    case "auto_retry_end":
      return [{ type: "notice", content: "Pi retry finished.", level: "info" }];
    case "extension_error":
      return [{ type: "notice", content: getString(event.error) ?? "Pi extension error.", level: "warning" }];
    default:
      return [];
  }
}

function isNested(event: Record<string, unknown>): boolean {
  return typeof event.parentToolCallId === "string";
}

// A finished assistant reply: its output tokens, and its error if it failed.
function normalizeReplyEnd(event: Record<string, unknown>): ChatChunk[] {
  const message = getRecord(event.message);
  if (message?.role !== "assistant") return [];
  const chunks: ChatChunk[] = [];
  const output = isPlainObject(message.usage) ? message.usage.output : undefined;
  if (typeof output === "number" && output > 0) chunks.push({ type: "usage", outputTokens: output });
  if (message.stopReason === "error") chunks.push({ type: "notice", content: getString(message.errorMessage) || "Pi turn failed.", level: "error" });
  return chunks;
}

/** Extension messages (`pi.sendMessage`) enter the conversation as role `custom`. */
function normalizeCustomMessage(event: Record<string, unknown>): ChatChunk[] {
  const message = getRecord(event.message);
  if (message?.role !== "custom") return [];
  const content = getPiCustomMessageDisplayText(message);
  return content ? [{ type: "notice", content, level: "info" }] : [];
}

/** Display text of an extension custom message; empty means nothing to display. */
export function getPiCustomMessageDisplayText(message: Record<string, unknown>): string {
  if (message.display === false) return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => (isPlainObject(block) && block.type === "text" && typeof block.text === "string" ? block.text : "")).join("");
}

function normalizeMessageUpdate(event: Record<string, unknown>): ChatChunk[] {
  const assistantEvent = getRecord(event.assistantMessageEvent);
  if (!assistantEvent) return [];
  const delta = getString(assistantEvent.delta);
  if (assistantEvent.type === "text_delta" && delta) return [{ type: "text", content: delta }];
  if (assistantEvent.type === "thinking_delta" && delta) return [{ type: "thinking", content: delta }];
  return [];
}

function normalizeToolUse(event: Record<string, unknown>, state: PiEventNormalizationState): ChatChunk[] {
  const id = getString(event.toolCallId);
  if (!id || state.emittedToolIds.has(id)) return [];
  state.emittedToolIds.add(id);
  return [{ type: "tool_use", id, name: getString(event.toolName) ?? "tool", input: normalizePiToolInput(event.args) }];
}

function normalizeToolOutput(event: Record<string, unknown>, state: PiEventNormalizationState): ChatChunk[] {
  const id = getString(event.toolCallId);
  if (!id) return [];
  const content = getToolOutputDelta(id, event.partialResult, state);
  return content ? [{ type: "tool_output", id, content }] : [];
}

function getToolOutputDelta(id: string, snapshot: unknown, state: PiEventNormalizationState): string {
  const content = extractPiToolTextContent(snapshot);
  if (!content) return "";
  // pi's partialResult is the tool's latest snapshot, but tool_output chunks
  // are appended by consumers. Stream only suffix growth; once a snapshot
  // stops extending the streamed text, wait for tool_result's final text.
  const previous = state.toolOutputs.get(id) ?? "";
  state.toolOutputs.set(id, content);
  if (state.divergedToolOutputIds.has(id)) return "";
  if (!content.startsWith(previous)) {
    state.divergedToolOutputIds.add(id);
    return "";
  }
  return content.slice(previous.length);
}

function normalizeToolResult(event: Record<string, unknown>, state: PiEventNormalizationState): ChatChunk[] {
  const id = getString(event.toolCallId);
  if (!id) return [];
  const result = event.result;
  const content = result === undefined ? (state.toolOutputs.get(id) ?? "") : extractPiToolResultText(getString(event.toolName) ?? "tool", result);
  state.toolOutputs.delete(id);
  state.divergedToolOutputIds.delete(id);
  const details = isPlainObject(result) ? result.details : undefined;
  return [{ type: "tool_result", id, content, isError: event.isError === true, details }];
}
