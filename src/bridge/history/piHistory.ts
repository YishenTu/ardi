// Adapted from Claudian (src/providers/pi/history/PiHistoryStore.ts).
// Rebuilds the chat from pi's session file, which is the record of the
// conversation. Kept: entry parsing, active-branch resolution, message and
// tool-result mapping. Consecutive assistant entries of one run merge into
// one message, as live output renders them.
// Each run also gets its duration, output tokens and whether it was stopped.
// TODO: branches/fork, images, subagents (all in Claudian).

import { readFile } from "node:fs/promises";

import type { AssistantBlock, ChatMessage, ToolCall } from "../../chat";
import { getPiCustomMessageDisplayText } from "../normalization/piEventNormalization";
import { extractPiToolResultText, getRecord, getString, isPlainObject, normalizePiToolInput } from "../normalization/piToolNormalization";

interface PiSessionEntry {
  id?: string;
  // The entry's message, or the entry itself for entries without one.
  message: Record<string, unknown>;
  parentId?: string;
  raw: Record<string, unknown>;
  type: string;
}

export async function readPiHistory(sessionFile: string): Promise<ChatMessage[]> {
  const entries: PiSessionEntry[] = [];
  // Split on LF only: U+2028/U+2029 are valid inside JSON strings.
  for (const line of (await readFile(sessionFile, "utf8")).split("\n")) addPiSessionLine(entries, line);
  return mapPiSessionEntries(resolvePiActivePath(entries));
}

function addPiSessionLine(entries: PiSessionEntry[], line: string): void {
  if (!line.trim()) return;
  let record: Record<string, unknown>;
  try {
    const value = JSON.parse(line) as unknown;
    if (!isPlainObject(value)) return;
    record = value;
  } catch {
    return;
  }
  const type = getString(record.type) ?? "";
  if (type === "session") return; // header
  entries.push({
    id: getString(record.id) ?? undefined,
    message: getRecord(record.message) ?? record,
    parentId: getString(record.parentId) ?? undefined,
    raw: record,
    type,
  });
}

function mapPiSessionEntries(entries: PiSessionEntry[]): ChatMessage[] {
  const messages: ChatMessage[] = [];
  // A run's duration runs from the user's message to its last entry.
  let runStart = 0;
  const extendRun = (writtenAt: number) => {
    const last = messages.at(-1);
    if (last?.role !== "assistant" || !runStart || writtenAt < runStart) return;
    last.completedAt = writtenAt;
    last.durationMs = writtenAt - runStart;
  };
  for (const [index, entry] of entries.entries()) {
    const { message } = entry;
    const role = getString(message.role);
    const id = entry.id ?? `pi-${index}`;
    const timestamp = getTimestamp(message.timestamp ?? entry.raw.timestamp);
    // When the entry was written, i.e. when that step finished.
    const writtenAt = getTimestamp(entry.raw.timestamp ?? message.timestamp);

    if (role === "user") {
      messages.push({ role: "user", id, content: extractTextContent(message.content), timestamp });
      runStart = timestamp;
    } else if (role === "assistant") {
      const blocks = extractAssistantContentBlocks(message.content);
      const toolCalls = extractAssistantToolCalls(message.content);
      const previous = messages.at(-1);
      if (previous?.role === "assistant") {
        previous.blocks.push(...blocks);
        previous.toolCalls.push(...toolCalls);
      } else {
        messages.push({ role: "assistant", id, blocks, toolCalls, timestamp });
      }
      const output = getRecord(message.usage)?.output;
      const run = messages.at(-1);
      if (run?.role === "assistant" && typeof output === "number") run.outputTokens = (run.outputTokens ?? 0) + output;
      if (run?.role === "assistant" && message.stopReason === "aborted") run.interrupted = true;
      extendRun(writtenAt);
    } else if (isToolResultEntry(entry)) {
      applyToolResult(messages, entry);
      extendRun(writtenAt);
    } else if (entry.type === "compaction") {
      messages.push({ role: "notice", id, content: "Context compacted.", level: "info", timestamp });
    } else if (entry.type === "custom_message") {
      const content = getPiCustomMessageDisplayText(entry.raw);
      if (content) messages.push({ role: "notice", id, content, level: "info", timestamp });
    } else if (entry.type === "branch_summary" && entry.raw.display !== false) {
      const content = extractTextContent(entry.raw.summary ?? entry.raw.content);
      if (content) messages.push({ role: "notice", id, content, level: "info", timestamp });
    }
  }
  return messages;
}

function extractAssistantContentBlocks(value: unknown): AssistantBlock[] {
  const blocks: AssistantBlock[] = [];
  const parts = Array.isArray(value) ? value : [{ type: "text", text: extractTextContent(value) }];
  for (const part of parts) {
    if (!isPlainObject(part)) continue;
    const type = getString(part.type);
    if (type === "thinking") {
      const content = extractTextContent(part.thinking ?? part.text);
      if (content) blocks.push({ type: "thinking", content });
    } else if (type === "toolCall") {
      const toolId = getString(part.id);
      if (toolId) blocks.push({ type: "tool_use", toolId });
    } else {
      const content = extractTextContent(part.text ?? part.content);
      if (content) blocks.push({ type: "text", content });
    }
  }
  return blocks;
}

function extractAssistantToolCalls(value: unknown): ToolCall[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((part): ToolCall[] => {
    if (!isPlainObject(part) || part.type !== "toolCall") return [];
    const id = getString(part.id);
    const name = getString(part.name);
    if (!id || !name) return [];
    return [{ id, name, input: normalizePiToolInput(part.arguments ?? part.input), status: "running" }];
  });
}

function isToolResultEntry(entry: PiSessionEntry): boolean {
  return getString(entry.message.role) === "toolResult";
}

function getToolResultCallId(entry: PiSessionEntry): string | null {
  return getString(entry.message.toolCallId);
}

function applyToolResult(messages: ChatMessage[], entry: PiSessionEntry): void {
  const toolCallId = getToolResultCallId(entry);
  if (!toolCallId) return;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== "assistant") continue;
    const toolCall = message.toolCalls.find((call) => call.id === toolCallId);
    if (!toolCall) continue;
    const result = entry.message;
    toolCall.status = result.isError === true ? "error" : "completed";
    toolCall.result = extractPiToolResultText(toolCall.name, result.content);
    toolCall.details = result.details;
    return;
  }
}

// Active branch: walk from the leaf (last entry) to the root via parentId,
// keeping tool results that belong to calls on that path.
function resolvePiActivePath(entries: PiSessionEntry[]): PiSessionEntry[] {
  const withIds = entries.filter((entry): entry is PiSessionEntry & { id: string } => !!entry.id);
  if (withIds.length === 0) return entries;
  const hasBranchGraph = withIds.some((entry) => !!entry.parentId && !isToolResultEntry(entry));
  if (!hasBranchGraph) return entries;

  const byId = new Map(withIds.map((entry) => [entry.id, entry] as const));
  const activeIds = new Set<string>();
  let current: PiSessionEntry | undefined = withIds.at(-1);
  while (current?.id && !activeIds.has(current.id)) {
    activeIds.add(current.id);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }

  const activeToolCallIds = new Set<string>();
  for (const entry of entries) {
    if (entry.id && activeIds.has(entry.id)) {
      for (const call of extractAssistantToolCalls(entry.message.content)) activeToolCallIds.add(call.id);
    }
  }
  return entries.filter((entry) => {
    if (isToolResultEntry(entry)) {
      const callId = getToolResultCallId(entry);
      return (!!callId && activeToolCallIds.has(callId)) || (!!entry.id && activeIds.has(entry.id));
    }
    return entry.id ? activeIds.has(entry.id) : !!entry.parentId && activeIds.has(entry.parentId);
  });
}

function extractTextContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(extractTextContent).filter(Boolean).join("");
  if (!isPlainObject(value)) return "";
  if (typeof value.text === "string") return value.text;
  if (typeof value.content === "string") return value.content;
  return "";
}

function getTimestamp(value: unknown): number {
  if (typeof value === "number") return value;
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isNaN(parsed) ? Date.now() : parsed;
}
