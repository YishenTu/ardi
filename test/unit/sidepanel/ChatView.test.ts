import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { $, loadPanel } from "../../support/panel";
import type { ChatChunk } from "../../../src/chat";
import { ChatView } from "../../../src/sidepanel/ChatView";

let root: HTMLElement;
let empty: HTMLElement;
let view: ChatView;

beforeEach(() => {
  loadPanel();
  root = $("history");
  empty = $("empty");
  view = new ChatView(root, empty);
});

// Stops the Working clock of a run a test left running.
afterEach(() => view.clear());

const play = (...chunks: ChatChunk[]) => chunks.forEach((chunk) => view.applyChunk(chunk));
const reply = () => root.querySelector<HTMLElement>(".msg.assistant")!;
// The reply's direct children, by class.
const layout = (msg: HTMLElement) => [...msg.children].map((child) => child.className);

describe("a live run", () => {
  test("streams into one reply with a Working line at the bottom", () => {
    play({ type: "run_start", at: 1000 }, { type: "text", content: "Hel" }, { type: "text", content: "lo **world**" });
    expect(empty.hidden).toBe(true);
    expect(root.querySelectorAll(".msg.assistant")).toHaveLength(1);
    expect(layout(reply())).toEqual(["md", "working"]);
    expect(reply().querySelector(".md")!.innerHTML).toContain("Hello <strong>world</strong>");

    play({ type: "tool_use", id: "t1", name: "bash", input: { command: "ls" } });
    expect(layout(reply())).toEqual(["md", "step tool", "working"]);
  });

  test("consecutive thinking deltas join into one block", () => {
    play({ type: "run_start", at: 0 }, { type: "thinking", content: "Let me " }, { type: "thinking", content: "think." });
    expect(reply().querySelectorAll(".thinking")).toHaveLength(1);
    expect(reply().querySelector(".thinking .step-body")!.textContent).toBe("Let me think.");
  });

  test("when it ends, its steps fold under Worked for, and the answer stays with a footer", () => {
    play(
      { type: "run_start", at: 1000 },
      { type: "text", content: "Checking." },
      { type: "tool_use", id: "t1", name: "bash", input: { command: "ls" } },
      { type: "tool_result", id: "t1", content: "a\nb", isError: false },
      { type: "text", content: "Two files." },
      { type: "usage", outputTokens: 50 },
      { type: "run_end", at: 3000 },
    );
    const msg = reply();
    expect(layout(msg)).toEqual(["work", "md", "msg-footer"]);
    expect(msg.querySelector(".work > summary")!.textContent).toBe("Worked for 2s");
    // Text between steps is part of the work; only the last text is the answer.
    expect([...msg.querySelectorAll(".work-body > *")].map((c) => c.className)).toEqual(["md", "step tool"]);
    expect(msg.querySelector(":scope > .md")!.textContent.trim()).toBe("Two files.");
    expect(msg.querySelector(".msg-rate")!.textContent).toBe("25.0 tok/s");
  });

  test("tool output streams into its card until the result replaces it", () => {
    play({ type: "run_start", at: 0 }, { type: "tool_use", id: "t1", name: "bash", input: { command: "seq 3" } });
    play({ type: "tool_output", id: "t1", content: "1\n" }, { type: "tool_output", id: "t1", content: "2\n" });
    const card = reply().querySelector<HTMLElement>(".tool")!;
    expect(card.querySelector(".tool-output pre")!.textContent).toBe("1\n2");
    play({ type: "tool_result", id: "t1", content: "1\n2\n3\n", isError: false });
    expect(card.dataset.status).toBe("completed");
    expect(card.querySelector(".tool-output pre")!.textContent).toBe("1\n2\n3");
  });

  test("a stopped run folds everything under Interrupted, even with no output", () => {
    play({ type: "run_start", at: 0 }, { type: "run_end", at: 500, interrupted: true });
    expect(reply().querySelector(".work .interrupted")!.textContent).toBe("Interrupted");
  });

  test("a run that produced nothing leaves no reply", () => {
    play({ type: "run_start", at: 0 }, { type: "run_end", at: 500 });
    expect(root.querySelector(".msg.assistant")).toBeNull();
  });
});

describe("history", () => {
  test("renders a saved run the way it looked when it finished live", () => {
    view.renderHistory([
      { role: "user", id: "u", content: "List tabs", timestamp: 1000 },
      {
        role: "assistant",
        id: "a",
        timestamp: 1000,
        completedAt: 5000,
        durationMs: 4000,
        blocks: [{ type: "thinking", content: "hmm" }, { type: "tool_use", toolId: "c1" }, { type: "text", content: "You have one tab." }],
        toolCalls: [{ id: "c1", name: "list_tabs", input: {}, status: "completed", result: "", details: [{ id: "1", title: "T", url: "https://a.b" }] }],
      },
      { role: "notice", id: "n", content: "Context compacted.", level: "info", timestamp: 6000 },
    ]);
    expect(root.querySelector(".msg.user")!.textContent).toBe("List tabs");
    const msg = reply();
    expect(layout(msg)).toEqual(["work", "md", "msg-footer"]);
    expect(msg.querySelector(".work > summary")!.textContent).toBe("Worked for 4s");
    expect(msg.querySelector(".tool .step-arg")!.textContent).toBe("1 tab");
    expect(root.querySelector(".msg.notice.info")!.textContent).toBe("Context compacted.");
  });

  test("a message's tab mentions show as chips linking to the tab", () => {
    view.addUser("compare [@Hacker News](https://news.ycombinator.com/) with this", 0);
    const msg = root.querySelector(".msg.user")!;
    expect(msg.textContent).toBe("compare Hacker News with this");
    expect(msg.querySelector<HTMLAnchorElement>("a.tab-chip")!.href).toBe("https://news.ycombinator.com/");
  });
});

describe("the empty state", () => {
  test("shows for a new chat, but not while a saved chat's messages load", () => {
    view.clear();
    expect(empty.hidden).toBe(false);
    view.clear(true);
    expect(empty.hidden).toBe(true);
  });
});

describe("answers", () => {
  test("are sanitized, and their links open in a new tab", () => {
    play({ type: "run_start", at: 0 }, { type: "text", content: '<img src="x" onerror="alert(1)"><script>alert(2)</script> [docs](https://example.com)' });
    const md = reply().querySelector(".md")!;
    expect(md.querySelector("script")).toBeNull();
    expect(md.querySelector("img")!.hasAttribute("onerror")).toBe(false);
    const link = md.querySelector("a")!;
    expect([link.getAttribute("target"), link.getAttribute("rel")]).toEqual(["_blank", "noreferrer"]);
  });

  test("copy puts the answer's markdown on the clipboard", async () => {
    let copied = "";
    const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => void (copied = text) } });
    try {
      play({ type: "run_start", at: 0 }, { type: "text", content: "**Done.**" }, { type: "run_end", at: 1000 });
      reply().querySelector<HTMLButtonElement>(".msg-copy")!.click();
      await Promise.resolve();
      expect(copied).toBe("**Done.**");
    } finally {
      if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
      else delete (navigator as { clipboard?: unknown }).clipboard;
    }
  });
});
