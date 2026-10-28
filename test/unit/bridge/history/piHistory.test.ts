import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readPiHistory } from "../../../../src/bridge/history/piHistory";

// Writes a session file in pi's format: a header line, then one entry per line.
function sessionFile(entries: Record<string, unknown>[], extraLines: string[] = []): string {
  const path = join(mkdtempSync(join(tmpdir(), "ardi-history-")), "session.jsonl");
  const header = { type: "session", version: 3, id: "s", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/" };
  writeFileSync(path, [header, ...entries].map((entry) => JSON.stringify(entry)).concat(extraLines).join("\n") + "\n");
  return path;
}

// A message entry, linked to the previous one like pi does.
let lastId: string | null = null;
function message(id: string, at: number, message: Record<string, unknown>, parentId = lastId) {
  lastId = id;
  return { type: "message", id, parentId, timestamp: new Date(at).toISOString(), message: { timestamp: at, ...message } };
}

describe("readPiHistory", () => {
  test("merges a run's assistant entries and tool results into one reply", async () => {
    lastId = null;
    const file = sessionFile([
      message("u1", 1000, { role: "user", content: [{ type: "text", text: "List my tabs" }] }),
      message("a1", 2000, {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Use list_tabs." },
          { type: "toolCall", id: "c1", name: "list_tabs", arguments: {} },
        ],
        usage: { output: 10 },
      }),
      message("r1", 3000, { role: "toolResult", toolCallId: "c1", toolName: "list_tabs", content: [{ type: "text", text: "2 tabs" }], details: [{ id: "1" }, { id: "2" }], isError: false }),
      message("a2", 5000, { role: "assistant", content: [{ type: "text", text: "You have 2 tabs." }], usage: { output: 5 } }),
    ]);

    expect(await readPiHistory(file)).toEqual([
      { role: "user", id: "u1", content: "List my tabs", timestamp: 1000 },
      {
        role: "assistant",
        id: "a1",
        timestamp: 2000,
        blocks: [
          { type: "thinking", content: "Use list_tabs." },
          { type: "tool_use", toolId: "c1" },
          { type: "text", content: "You have 2 tabs." },
        ],
        toolCalls: [{ id: "c1", name: "list_tabs", input: {}, status: "completed", result: "2 tabs", details: [{ id: "1" }, { id: "2" }] }],
        outputTokens: 15,
        completedAt: 5000,
        durationMs: 4000,
      },
    ]);
  });

  test("marks failed tools and stopped runs", async () => {
    lastId = null;
    const file = sessionFile([
      message("u1", 1000, { role: "user", content: "Do it" }),
      message("a1", 2000, { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "false" } }] }),
      message("r1", 2500, { role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: "exit 1" }], isError: true }),
      message("a2", 3000, { role: "assistant", content: [], stopReason: "aborted" }),
    ]);
    const [, reply] = await readPiHistory(file);
    expect(reply).toMatchObject({ role: "assistant", interrupted: true, toolCalls: [{ status: "error", result: "exit 1" }] });
  });

  test("shows only the active branch: the path from the last entry back to the root", async () => {
    lastId = null;
    const file = sessionFile([
      message("u1", 1000, { role: "user", content: "First try" }),
      message("a1", 2000, { role: "assistant", content: [{ type: "text", text: "Old answer" }] }),
      // The user went back and edited their message: a new branch from the root.
      message("u2", 3000, { role: "user", content: "Second try" }, null),
      message("a2", 4000, { role: "assistant", content: [{ type: "text", text: "New answer" }] }),
    ]);
    const history = await readPiHistory(file);
    expect(history).toHaveLength(2);
    expect(history).toMatchObject([{ role: "user", content: "Second try" }, { role: "assistant", blocks: [{ type: "text", content: "New answer" }] }]);
  });

  test("keeps U+2028 inside messages and skips lines that aren't JSON", async () => {
    lastId = null;
    const file = sessionFile([message("u1", 1000, { role: "user", content: "a b" })], ["{ broken", "[]"]);
    expect(await readPiHistory(file)).toEqual([{ role: "user", id: "u1", content: "a b", timestamp: 1000 }]);
  });

  test("compaction and extension messages become notices", async () => {
    lastId = null;
    const file = sessionFile([
      message("u1", 1000, { role: "user", content: "hi" }),
      { type: "compaction", id: "k1", parentId: "u1", timestamp: new Date(2000).toISOString(), summary: "..." },
      { type: "custom_message", id: "m1", parentId: "k1", timestamp: new Date(3000).toISOString(), content: "Extension says hi" },
      { type: "custom_message", id: "m2", parentId: "m1", timestamp: new Date(4000).toISOString(), content: "Hidden", display: false },
    ]);
    expect((await readPiHistory(file)).slice(1)).toEqual([
      { role: "notice", id: "k1", content: "Context compacted.", level: "info", timestamp: 2000 },
      { role: "notice", id: "m1", content: "Extension says hi", level: "info", timestamp: 3000 },
    ]);
  });
});
