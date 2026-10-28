import type { LiveItem, PiStatus, SessionMeta } from "../shared";
import { ChatView } from "./ChatView";
import { Composer } from "./Composer";
import { el } from "./dom";
import { ModelPicker } from "./ModelPicker";
import { PiClient } from "./pi";
import { SettingsView } from "./SettingsView";
import { SlashMenu } from "./SlashMenu";
import { TabMenu } from "./TabMenu";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const form = $<HTMLFormElement>("composer");
const input = new Composer($("input"));
const statusDot = $("status");
const statusText = $("status-text");
const titleEl = $("title");
const chatsToggle = $("chats-toggle");
const chats = $("chats");
const chatList = $("chat-list");

const view = new ChatView($("history"), $("empty"));

const STATUS_TEXT: Record<PiStatus, string> = {
  connected: "Running",
  connecting: "Starting…",
  disconnected: "Not running",
};

// While pi works, Esc stops it.
let busy = false;

function setStatus(s: PiStatus) {
  statusDot.dataset.state = s;
  statusDot.title = STATUS_TEXT[s];
  statusText.textContent = STATUS_TEXT[s];
  if (s === "disconnected") busy = false;
}

function applyLive(item: LiveItem) {
  if (item.kind === "prompt") return view.addUser(item.text, item.at);
  if (item.chunk.type === "run_start") busy = true;
  if (item.chunk.type === "run_end") busy = false;
  view.applyChunk(item.chunk);
}

const dateFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const clockFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

function when(ts: number): string {
  const date = new Date(ts);
  return date.toDateString() === new Date().toDateString() ? clockFormat.format(date) : dateFormat.format(date);
}

const TRASH_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 4.5h9M6.5 4.5V3h3v1.5M5 4.5l.5 8h5l.5-8" /></svg>';

function renderSessions(sessions: SessionMeta[], currentId: number) {
  const current = sessions.find((s) => s.id === currentId);
  titleEl.textContent = current?.title || "New chat";
  // Newest first, as the background sends them.
  chatList.replaceChildren(
    ...sessions.map((s) => {
      const li = el("li");
      li.setAttribute("aria-current", String(s.id === currentId));

      const open = li.appendChild(el("button", "chat-open"));
      open.append(el("span", "", s.title || "New chat"), el("time", "", when(s.updatedAt)));
      open.addEventListener("click", () => {
        chats.hidePopover();
        if (s.id !== currentId) pi.send({ kind: "switch_session", id: s.id });
      });

      // First click arms, second click deletes.
      const del = li.appendChild(el("button", "chat-delete"));
      del.title = "Delete chat";
      del.innerHTML = TRASH_ICON;
      del.addEventListener("click", () => {
        if (!del.classList.contains("armed")) {
          del.classList.add("armed");
          del.textContent = "Delete";
          return;
        }
        pi.send({ kind: "delete_session", id: s.id });
      });
      del.addEventListener("mouseleave", () => {
        if (!del.classList.contains("armed")) return;
        del.classList.remove("armed");
        del.innerHTML = TRASH_ICON;
      });
      return li;
    }),
  );
}

const pi = new PiClient({
  replay(history, live) {
    shufflePlaceholder();
    view.clear(history === null);
    busy = false;
    view.renderHistory(history ?? []);
    live.forEach(applyLive);
  },
  model: (state) => picker.render(state),
  commands: (commands) => slash.setCommands(commands),
  live: applyLive,
  status: setStatus,
  sessions: renderSessions,
});

function send(text: string) {
  text = text.trim();
  if (!text) return;
  pi.send({ kind: "prompt", text }); // echoed back as a live item, which renders it
  input.value = "";
}

// A different nudge each time the chat changes.
const PLACEHOLDERS = [
  "What are all these tabs, honestly?",
  "Read it so I don't have to",
  "TL;DR this page for me",
  "Ask me about any tab, I won't judge",
  "47 tabs open and counting…",
  "Find that thing I saw earlier",
  "Explain it like I skimmed it",
  "Go click the buttons for me",
];

function shufflePlaceholder() {
  input.el.dataset.placeholder = PLACEHOLDERS[Math.floor(Math.random() * PLACEHOLDERS.length)];
}

const field = input.el.parentElement!;

// Stacks the pickers under the text once it no longer fits on one line
// beside them.
function stackPickers() {
  field.classList.remove("stacked");
  const lineHeight = parseFloat(getComputedStyle(input.el).lineHeight);
  if (input.el.scrollHeight > lineHeight * 1.5) field.classList.add("stacked");
}

const slash = new SlashMenu(input, $("slash"), [
  { name: "new", description: "Start a new chat", run: () => pi.send({ kind: "new_session" }) },
  { name: "compact", description: "Summarize this chat to free up context", run: () => pi.send({ kind: "compact" }) },
]);

const tabMenu = new TabMenu(input, $("tab-menu"));

const settings = new SettingsView($("settings"));
$("ardi-version").textContent = chrome.runtime.getManifest().version;
$("settings-open").addEventListener("click", () => void settings.open());

const picker = new ModelPicker($("model"), $("thinking"), $("menu"), {
  setModel: (provider, modelId) => pi.send({ kind: "set_model", provider, modelId }),
  setThinkingLevel: (level) => pi.send({ kind: "set_thinking_level", level }),
});

form.addEventListener("submit", (e) => {
  e.preventDefault();
  send(input.value);
});
input.el.addEventListener("keydown", (e) => {
  if (slash.keydown(e) || tabMenu.keydown(e)) return;
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    send(input.value);
  }
});
input.el.addEventListener("input", () => {
  stackPickers();
  slash.update();
  void tabMenu.update();
});
// The caret can leave an @word without typing (arrows, clicks).
document.addEventListener("selectionchange", () => void tabMenu.update());
window.addEventListener("resize", stackPickers);
document.addEventListener("keydown", (e) => {
  // An open menu takes Esc first (it closes itself).
  if (e.key === "Escape" && busy && !settings.isOpen && !document.querySelector(":popover-open")) pi.send({ kind: "abort" });
});
$("new").addEventListener("click", () => {
  pi.send({ kind: "new_session" });
  input.focus();
});
$("restart").addEventListener("click", () => pi.send({ kind: "restart" }));
chats.addEventListener("toggle", (e) => {
  chatsToggle.setAttribute("aria-expanded", String(e.newState === "open"));
});
for (const button of document.querySelectorAll<HTMLButtonElement>(".suggestions button")) {
  button.addEventListener("click", () => send(button.dataset.prompt!));
}

pi.connect();
input.focus();
