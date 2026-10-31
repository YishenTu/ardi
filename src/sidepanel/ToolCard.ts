import type { ToolCall } from "../chat";
import { el, host, opensTab, step } from "./dom";

// A tool call as the panel tracks it: the call plus output streamed while it runs.
export type ToolState = ToolCall & { output?: string };

// Output longer than this collapses behind "Show all".
const PREVIEW_LINES = 12;

// How the panel shows a tool. Tools of different browsers that do the same
// thing share a view, so every build looks alike.
type View = "tabs" | "tab" | "opened_tab" | "image" | "code" | "shell" | "write" | "edit" | "search" | "files";

const TOOLS: Record<string, { label: string; view: View }> = {
  list_tabs: { label: "Listed tabs", view: "tabs" },
  read_tab: { label: "Read tab", view: "tab" },
  view_image: { label: "Viewed image", view: "image" },
  open_tab: { label: "Opened tab", view: "opened_tab" },
  // Each browser's own way to act in the page: Python in Ardia, JavaScript in Chrome.
  ardia_exec: { label: "Ran in browser", view: "code" },
  browser_exec: { label: "Ran in browser", view: "code" },
  read: { label: "Read", view: "files" },
  write: { label: "Wrote", view: "write" },
  edit: { label: "Edited", view: "edit" },
  bash: { label: "Ran", view: "shell" },
  powershell: { label: "Ran", view: "shell" },
  grep: { label: "Searched", view: "search" },
  find: { label: "Found files", view: "search" },
  ls: { label: "Listed", view: "files" },
  codemode: { label: "Ran code", view: "code" },
};

type Tab = { id?: string; title?: string; url?: string; current?: boolean };

// A collapsed row that expands to the tool's input and result.
export function toolCard(call: ToolState): HTMLElement {
  const card = step("tool", TOOLS[call.name]?.label ?? call.name);
  updateToolCard(card, call);
  return card;
}

// Redraws the card from the call's current state; keeps it open or closed,
// and keeps a "Show all" the user clicked. While the tool runs, new output
// only updates the output box.
export function updateToolCard(card: HTMLElement, call: ToolState) {
  const body = card.querySelector(".step-body")!;
  const box = body.querySelector<HTMLElement>(".tool-output");
  if (call.status === "running" && box?.classList.contains("live")) return setOutput(box, call.output ?? "");
  card.dataset.status = call.status;
  card.querySelector(".step-arg")!.textContent = summaryArg(call);
  body.replaceChildren(...bodyFor(call));
  if (box?.dataset.expanded === "true") body.querySelector<HTMLButtonElement>(".tool-more")?.click();
  if (call.status === "running") body.querySelector(".tool-output")?.classList.add("live");
}

// One short line next to the label.
function summaryArg(call: ToolState): string {
  const input = call.input;
  const details = record(call.details);
  switch (TOOLS[call.name]?.view) {
    case "tabs":
      return Array.isArray(call.details) ? `${call.details.length} tab${call.details.length === 1 ? "" : "s"}` : "";
    case "tab":
      return str(details?.title) || host(str(input.url)) || (str(input.id) ? "tab" : "current tab");
    case "opened_tab":
      return host(str(details?.url) || str(input.url));
    case "image":
      return `image ${typeof input.image === "number" ? input.image : "?"}${str(details?.title) ? ` on ${str(details?.title)}` : ""}`;
    case "code":
      return firstLine(str(input.code)) || str(input.method) || sent(input);
    case "search":
      return str(input.pattern);
    case "shell":
    case "write":
    case "edit":
    case "files":
    case undefined:
      return firstLine(str(input.command) || str(input.path) || str(input.pattern) || str(input.url) || "");
  }
}

function bodyFor(call: ToolState): Node[] {
  const input = call.input;
  const details = record(call.details);
  const result = call.result ?? call.output ?? "";
  if (call.status === "error") return [...inputView(call), output(result, "error")];

  switch (TOOLS[call.name]?.view) {
    case "shell":
      return [code(`${call.name === "powershell" ? "PS>" : "$"} ${str(input.command)}`), ...(result ? [output(result)] : [])];
    case "code":
      return [code(sent(input)), ...(result ? [output(result)] : [])];
    case "write":
      return [code(str(input.content))];
    case "edit": {
      const patch = str(details?.patch);
      return patch ? [diff(patch)] : [...inputView(call), ...(result ? [output(result)] : [])];
    }
    case "tabs":
      return Array.isArray(call.details) ? [tabList(call.details as Tab[])] : result ? [output(result)] : [];
    case "opened_tab":
      return details ? [tabList([details])] : [];
    case "tab": {
      if (!details) return result ? [output(result)] : [];
      // read_tab's text starts with the title and URL (each target's agent extension),
      // which the tab row shows.
      const tab = details as Tab;
      const header = `${tab.title}\n${tab.url}\n\n`;
      const text = result.startsWith(header) ? result.slice(header.length) : result;
      return [tabList([tab]), ...(text.trim() ? [output(text)] : [])];
    }
    case "search":
    case "files":
      return result ? [output(result)] : [];
    case "image":
    case undefined:
      return [...inputView(call), ...(result ? [output(result)] : [])];
  }
}

// What a code tool sent: its code, or for browser_exec, a CDP command and
// its params, or closing a tab.
function sent(input: Record<string, unknown>): string {
  if (str(input.code)) return str(input.code);
  if (str(input.method)) return input.params ? `${str(input.method)} ${JSON.stringify(input.params, null, 2)}` : str(input.method);
  if (input.close === true) return `close tab ${str(input.id)}`;
  return "";
}

// The input as `key  value` rows, for tools without their own view.
function inputView(call: ToolState): Node[] {
  const entries = Object.entries(call.input).filter(([, v]) => v !== undefined && v !== null && v !== "");
  if (!entries.length) return [];
  const list = el("dl", "tool-input");
  for (const [key, value] of entries) {
    list.append(el("dt", "", key), el("dd", "", typeof value === "string" ? value : JSON.stringify(value, null, 2)));
  }
  return [list];
}

function code(text: string): HTMLElement {
  return el("pre", "tool-code", text);
}

// Tool output; long output shows its first lines with a button for the rest.
function output(text: string, kind = ""): HTMLElement {
  const box = el("div", `tool-output ${kind}`.trim());
  setOutput(box, text);
  return box;
}

function setOutput(box: HTMLElement, text: string) {
  const lines = text.replace(/\n+$/, "").split("\n");
  const expanded = box.dataset.expanded === "true";
  const pre = box.querySelector("pre") ?? box.appendChild(el("pre"));
  pre.textContent = (expanded ? lines : lines.slice(0, PREVIEW_LINES)).join("\n");
  box.querySelector(".tool-more")?.remove();
  if (expanded || lines.length <= PREVIEW_LINES) return;
  const more = box.appendChild(el("button", "tool-more", `Show all ${lines.length} lines`));
  more.type = "button";
  more.addEventListener("click", () => {
    box.dataset.expanded = "true";
    pre.textContent = lines.join("\n");
    more.remove();
  });
}

// A unified patch with added and removed lines marked.
function diff(patch: string): HTMLElement {
  const box = el("pre", "tool-diff");
  for (const line of patch.replace(/\n$/, "").split("\n")) {
    if (line.startsWith("---") || line.startsWith("+++")) continue;
    const kind = line.startsWith("@@") ? "hunk" : line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "";
    box.append(el("span", kind, `${line}\n`));
  }
  return box;
}

function tabList(tabs: Tab[]): HTMLElement {
  const list = el("ul", "tool-tabs");
  for (const tab of tabs) {
    const row = list.appendChild(el("li", tab.current ? "current" : ""));
    const link = row.appendChild(el("a", "", tab.title || tab.url || "Untitled"));
    if (tab.url) {
      opensTab(link, tab.url);
      link.title = tab.url;
    }
    row.append(el("span", "tool-tab-host", host(tab.url ?? "")));
  }
  return list;
}

function firstLine(text: string): string {
  return text.trim().split("\n")[0];
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
