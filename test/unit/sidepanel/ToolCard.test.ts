import { describe, expect, test } from "bun:test";

import { toolCard, updateToolCard, type ToolState } from "../../../src/sidepanel/ToolCard";

const lines = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => `line ${from + i}`).join("\n");
const summary = (card: HTMLElement) => [card.querySelector(".step-label")!.textContent, card.querySelector(".step-arg")!.textContent];
const shownLines = (card: HTMLElement) => card.querySelector(".tool-output pre")!.textContent.split("\n").length;
const showAll = (card: HTMLElement) => card.querySelector<HTMLButtonElement>(".tool-more")!.click();

function call(overrides: Partial<ToolState>): ToolState {
  return { id: "t1", name: "bash", input: {}, status: "completed", ...overrides };
}

describe("summary line", () => {
  test("counts listed tabs", () => {
    expect(summary(toolCard(call({ name: "list_tabs", details: [{ id: "1" }] })))[1]).toBe("1 tab");
    expect(summary(toolCard(call({ name: "list_tabs", details: [{ id: "1" }, { id: "2" }] })))[1]).toBe("2 tabs");
  });

  test("shows the tool's state", () => {
    const card = toolCard(call({ status: "running" }));
    expect(card.dataset.status).toBe("running");
    updateToolCard(card, call({ status: "error", result: "boom" }));
    expect(card.dataset.status).toBe("error");
    expect(card.querySelector(".tool-output.error")?.textContent).toBe("boom");
  });
});

// Each build has its own exec tool; the panel shows them the same way.
test("every browser's exec tool shows as the same code card", () => {
  for (const name of ["ardia_exec", "browser_exec"]) {
    const card = toolCard(call({ name, input: { code: "first()\nsecond()" }, result: "done" }));
    expect(summary(card)).toEqual(["Ran in browser", "first()"]);
    expect(card.querySelector(".tool-code")!.textContent).toBe("first()\nsecond()");
    expect(card.querySelector(".tool-output pre")!.textContent).toBe("done");
  }
});

// browser_exec can send a CDP command or close a tab instead of running code.
test("an exec call without code shows the command it sent", () => {
  const typed = toolCard(call({ name: "browser_exec", input: { id: "42", method: "Input.insertText", params: { text: "Hi" } } }));
  expect(summary(typed)).toEqual(["Ran in browser", "Input.insertText"]);
  expect(typed.querySelector(".tool-code")!.textContent).toBe('Input.insertText {\n  "text": "Hi"\n}');
  const closed = toolCard(call({ name: "browser_exec", input: { id: "42", close: true } }));
  expect(summary(closed)).toEqual(["Ran in browser", "close tab 42"]);
  expect(closed.querySelector(".tool-code")!.textContent).toBe("close tab 42");
});

describe("read_tab", () => {
  test("shows the tab as a link and drops the title and URL the text starts with", () => {
    const tab = { id: "1", title: "Docs", url: "https://example.com/docs" };
    const card = toolCard(call({ name: "read_tab", details: tab, result: "Docs\nhttps://example.com/docs\n\nThe body\nline two" }));
    const link = card.querySelector<HTMLAnchorElement>(".tool-tabs a")!;
    expect([link.textContent, link.href, link.target]).toEqual(["Docs", "https://example.com/docs", "_blank"]);
    expect(card.querySelector(".tool-output pre")!.textContent).toBe("The body\nline two");
  });

  test("keeps text that doesn't start with that header", () => {
    const card = toolCard(call({ name: "read_tab", details: { title: "Docs", url: "https://x" }, result: "Docs\nsomething else\n\nbody" }));
    expect(card.querySelector(".tool-output pre")!.textContent).toBe("Docs\nsomething else\n\nbody");
  });
});

describe("edit", () => {
  test("shows the patch with added and removed lines marked, without file headers", () => {
    const card = toolCard(call({ name: "edit", details: { patch: "--- a/f\n+++ b/f\n@@ -1 +1 @@\n-old\n+new\n same" } }));
    const marks = [...card.querySelectorAll(".tool-diff > span")].map((line) => [line.className, line.textContent]);
    expect(marks).toEqual([
      ["hunk", "@@ -1 +1 @@\n"],
      ["del", "-old\n"],
      ["add", "+new\n"],
      ["", " same\n"],
    ]);
  });
});

describe("long output", () => {
  test("shows the first 12 lines with a button for the rest", () => {
    const card = toolCard(call({ result: lines(0, 30) }));
    expect(shownLines(card)).toBe(12);
    expect(card.querySelector(".tool-more")!.textContent).toBe("Show all 30 lines");
    showAll(card);
    expect(shownLines(card)).toBe(30);
    expect(card.querySelector(".tool-more")).toBeNull();
  });

  test("stays expanded while the tool streams more output, and after it finishes", () => {
    const card = toolCard(call({ status: "running", output: lines(0, 20) }));
    showAll(card);
    updateToolCard(card, call({ status: "running", output: lines(0, 40) }));
    expect(shownLines(card)).toBe(40);
    updateToolCard(card, call({ status: "completed", result: lines(0, 50) }));
    expect(shownLines(card)).toBe(50);
  });

  test("a collapsed preview keeps its button up to date as output streams", () => {
    const card = toolCard(call({ status: "running", output: lines(0, 20) }));
    updateToolCard(card, call({ status: "running", output: lines(0, 25) }));
    expect(shownLines(card)).toBe(12);
    expect(card.querySelectorAll(".tool-more")).toHaveLength(1);
    expect(card.querySelector(".tool-more")!.textContent).toBe("Show all 25 lines");
  });
});
