import DOMPurify from "dompurify";
import { marked } from "marked";
import type { ChatChunk, ChatMessage, NoticeLevel, ToolCall } from "../chat";
import { splitMentions, type TabMention } from "../mention";
import { el, opensTab, step, tabChip } from "./dom";
import { toolCard, updateToolCard, type ToolState } from "./ToolCard";

// Links in answers open in a new tab instead of navigating the panel.
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noreferrer");
  }
});

// Answers can quote page content, so the HTML is always sanitized.
function markdown(text: string): string {
  return DOMPurify.sanitize(marked.parse(text, { async: false, gfm: true }));
}

// Renders the conversation: history messages from pi's session file, then
// live chunks. A run renders as one assistant message, like history does.
export class ChatView {
  // The assistant message of the current run, if one is streaming.
  private current: HTMLElement | null = null;
  // Text or thinking block the next delta of the same kind appends to.
  private tail: { type: "text" | "thinking"; el: HTMLElement; raw: string } | null = null;
  private readonly tools = new Map<string, { card: HTMLElement; call: ToolState }>();
  // The "Working…" line at the bottom of the running reply, and its clock.
  private working: { el: HTMLElement; timer: number } | null = null;
  // The running run's start and the output tokens reported so far.
  private run: { start: number; tokens: number } | null = null;

  constructor(
    private readonly root: HTMLElement,
    private readonly empty: HTMLElement,
  ) {}

  // `loading`: a saved chat whose messages are on their way, so the empty
  // state stays hidden instead of flashing before them.
  clear(loading = false) {
    this.stopWorking();
    this.root.replaceChildren(this.empty);
    this.empty.hidden = loading;
    this.current = null;
    this.tail = null;
    this.tools.clear();
  }

  renderHistory(messages: ChatMessage[]) {
    for (const message of messages) {
      if (message.role === "user") this.addUser(message.content, message.timestamp);
      else if (message.role === "notice") this.addNotice(message.content, message.level);
      else this.addAssistant(message);
    }
  }

  addUser(text: string, at: number) {
    const entry = this.append(el("div", "entry user"));
    const msg = el("div", "msg user");
    for (const part of splitMentions(text)) msg.append(typeof part === "string" ? part : mentionLink(part));
    entry.append(msg, footer({ copy: () => text, at }));
  }

  addNotice(text: string, level: NoticeLevel) {
    this.append(el("div", `msg notice ${level}`, text));
  }

  applyChunk(chunk: ChatChunk) {
    switch (chunk.type) {
      case "run_start":
        this.current = this.append(el("div", "msg assistant"));
        this.endTail();
        this.startWorking(this.current, chunk.at);
        this.run = { start: chunk.at, tokens: 0 };
        break;
      case "usage":
        if (this.run) this.run.tokens += chunk.outputTokens;
        break;
      case "run_end": {
        this.endTail();
        this.stopWorking();
        const msg = this.current;
        const run = this.run;
        this.current = null;
        this.run = null;
        if (!msg) break;
        // A stopped run keeps its message, even empty, for the indicator.
        if (!msg.childElementCount && !chunk.interrupted) msg.remove();
        else if (run) finishRun(msg, { completedAt: chunk.at, durationMs: chunk.at - run.start, outputTokens: run.tokens, interrupted: chunk.interrupted });
        break;
      }
      case "text":
      case "thinking":
        this.appendDelta(chunk.type, chunk.content);
        break;
      case "tool_use":
        this.endTail();
        this.add(this.trackTool({ id: chunk.id, name: chunk.name, input: chunk.input, status: "running" }));
        break;
      case "tool_output":
        this.updateTool(chunk.id, (call) => ({ ...call, output: (call.output ?? "") + chunk.content }));
        break;
      case "tool_result":
        this.updateTool(chunk.id, (call) => ({
          ...call,
          status: chunk.isError ? "error" : "completed",
          result: chunk.content,
          details: chunk.details,
        }));
        break;
      case "notice":
        this.addNotice(chunk.content, chunk.level);
        break;
    }
  }

  private addAssistant(message: Extract<ChatMessage, { role: "assistant" }>) {
    const { blocks, toolCalls } = message;
    const msg = this.append(el("div", "msg assistant"));
    for (const block of blocks) {
      if (block.type === "tool_use") {
        const call = toolCalls.find((c) => c.id === block.toolId);
        if (call) msg.append(this.trackTool(call));
      } else if (block.type === "text") {
        msg.append(textBlock(block.content));
      } else {
        msg.append(thinkingBlock(block.content));
      }
    }
    if (msg.childElementCount || message.interrupted) finishRun(msg, message);
  }

  private startWorking(msg: HTMLElement, startedAt: number) {
    this.stopWorking();
    const line = msg.appendChild(el("div", "working"));
    const hint = el("span", "working-hint");
    line.append(el("span", "working-label", "Working…"), hint);
    const tick = () => (hint.textContent = ` (esc to interrupt · ${formatDuration(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)))})`);
    tick();
    this.working = { el: line, timer: window.setInterval(tick, 1000) };
  }

  private stopWorking() {
    if (!this.working) return;
    clearInterval(this.working.timer);
    this.working.el.remove();
    this.working = null;
  }

  // Adds a block to the running reply, above the "Working…" line.
  private add(node: HTMLElement): HTMLElement {
    const msg = this.ensureCurrent();
    const working = this.working?.el.parentElement === msg ? this.working.el : null;
    msg.insertBefore(node, working);
    this.scroll();
    return node;
  }

  private appendDelta(type: "text" | "thinking", content: string) {
    if (this.tail?.type !== type) {
      this.endTail();
      const node = type === "text" ? textBlock("") : thinkingBlock("", true);
      this.tail = { type, el: this.add(node), raw: "" };
    }
    this.tail.raw += content;
    if (type === "text") {
      this.tail.el.innerHTML = markdown(this.tail.raw);
      this.tail.el.dataset.raw = this.tail.raw;
    }
    else this.tail.el.querySelector(".step-body")!.textContent = this.tail.raw;
    this.scroll();
  }

  // The streaming block is complete once something else follows it.
  private endTail() {
    this.tail?.el.classList.remove("live");
    this.tail = null;
  }

  // A card for `call` that later tool chunks update.
  private trackTool(call: ToolCall): HTMLElement {
    const card = toolCard(call);
    this.tools.set(call.id, { card, call });
    return card;
  }

  private updateTool(id: string, change: (call: ToolState) => ToolState) {
    const tool = this.tools.get(id);
    if (!tool) return;
    tool.call = change(tool.call);
    updateToolCard(tool.card, tool.call);
    this.scroll();
  }

  private ensureCurrent(): HTMLElement {
    this.current ??= this.append(el("div", "msg assistant"));
    return this.current;
  }

  private append(node: HTMLElement): HTMLElement {
    this.empty.hidden = true;
    this.root.append(node);
    this.scroll();
    return node;
  }

  // Follows new output only while the reader is at the bottom.
  private scroll() {
    const { scrollTop, scrollHeight, clientHeight } = this.root;
    if (scrollHeight - scrollTop - clientHeight < 120) this.root.scrollTop = scrollHeight;
  }
}

// Claudian's format: "45s", "1m 5s".
function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

type RunStats = { completedAt?: number; durationMs?: number; outputTokens?: number; interrupted?: boolean };

function mentionLink(tab: TabMention): HTMLAnchorElement {
  const link = tabChip("a", tab);
  opensTab(link, tab.url);
  return link;
}

// A finished run: steps fold away and a footer copies the answer.
// A stopped run has no answer: everything folds under "Interrupted".
function finishRun(msg: HTMLElement, stats: RunStats) {
  if (stats.interrupted) {
    foldWork(msg, [el("span", "interrupted", "Interrupted")], true);
    // Also mark where the run stopped, at the end of its steps.
    msg.querySelector(".work-body")?.append(el("div", "interrupted-end", "Interrupted"));
    if (stats.completedAt) msg.append(footer({ at: stats.completedAt }));
    return;
  }
  if (stats.durationMs !== undefined) foldWork(msg, [`Worked for ${formatDuration(Math.round(stats.durationMs / 1000))}`]);
  // The answer is the text left outside the fold.
  const answer = () => [...msg.querySelectorAll<HTMLElement>(":scope > .md")].map((md) => md.dataset.raw ?? md.innerText).join("\n\n");
  const seconds = (stats.durationMs ?? 0) / 1000;
  const rate = stats.outputTokens && seconds > 0 ? { tokens: stats.outputTokens, perSecond: stats.outputTokens / seconds, seconds } : undefined;
  msg.append(footer({ copy: answer, at: stats.completedAt, rate }));
}

const clockFormat = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const COPY_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5.5" y="5.5" width="7.5" height="7.5" rx="1.5" /><path d="M10.5 5.5V4a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5" /></svg>';
const CHECK_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" /></svg>';

// The row under a message: copy, then tok/s for replies, then the time.
function footer(opts: { copy?: () => string; at?: number; rate?: { tokens: number; perSecond: number; seconds: number } }): HTMLElement {
  const row = el("div", "msg-footer");
  const { copy: text } = opts;
  if (text) {
    const copy = row.appendChild(el("button", "msg-copy"));
    copy.type = "button";
    copy.title = "Copy";
    copy.innerHTML = COPY_ICON;
    copy.addEventListener("click", () => {
      void navigator.clipboard.writeText(text()).then(() => {
        copy.innerHTML = CHECK_ICON;
        setTimeout(() => (copy.innerHTML = COPY_ICON), 1500);
      });
    });
  }
  if (opts.rate) {
    const rate = row.appendChild(el("span", "msg-rate", `${opts.rate.perSecond.toFixed(1)} tok/s`));
    rate.title = `${opts.rate.tokens.toLocaleString()} tokens · ${formatDuration(Math.round(opts.rate.seconds))}`;
  }
  if (opts.at) {
    const time = row.appendChild(el("time", "msg-time", clockFormat.format(opts.at)));
    time.title = new Date(opts.at).toLocaleString();
  }
  return row;
}

// Once a run ends, its steps (thinking, tools and any text between them) fold
// under `label` above the final answer; with `all`, everything folds.
function foldWork(msg: HTMLElement, label: (Node | string)[], all = false) {
  const children = [...msg.children] as HTMLElement[];
  const end = all ? children.length - 1 : children.findLastIndex((child) => child.classList.contains("step"));
  if (end < 0) {
    const line = el("div", "work");
    line.append(...label);
    msg.prepend(line);
    return;
  }
  const work = el("details", "work");
  work.appendChild(el("summary")).append(...label);
  const body = work.appendChild(el("div", "work-body"));
  body.append(...children.slice(0, end + 1));
  msg.prepend(work);
}

function textBlock(content: string): HTMLElement {
  const node = el("div", "md");
  node.innerHTML = markdown(content);
  node.dataset.raw = content;
  return node;
}

function thinkingBlock(content: string, live = false): HTMLElement {
  const details = step(`thinking${live ? " live" : ""}`, "Thinking");
  details.querySelector(".step-body")!.textContent = content;
  return details;
}
