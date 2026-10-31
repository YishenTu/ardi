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
  "Accept all cookies? Let's talk about it",
  "Is this a scam? Be honest",
  "Close the tabs I'll never read",
  "Summarize the comments, skip the drama",
  "Which of these reviews are real?",
  "Fill out this form, I believe in you",
  "Why is this page 90% ads?",
  "Pretend I read the terms and conditions",
  "Where did the download button go?",
  "Translate this corporate speak",
  "Find the recipe, skip the life story",
  "I opened this tab for a reason. Why?",
  "Compare prices so I can stop doom-scrolling",
  "Unsubscribe me from my mistakes",
  "Is it just me, or is this page broken?",
  "Do the boring part",
  "Who wrote this, and are they okay?",
  "Find the 'no thanks' button they hid",
  "Is this news or just vibes?",
  "Tell me which tab is playing music",
  "Be my second pair of eyeballs",
  "Make sense of this spreadsheet, please",
  "Did I already buy this?",
  "Read the fine print, the really fine print",
  "Explain this error like I'm five",
  "What's the catch?",
  "Skip the 12-minute video, give me the answer",
  "Help, I clicked something",
  "Draft a reply that sounds like I tried",
  "Why does this site want my location?",
  "Is this worth a whole afternoon?",
  "Find the one tab that matters",
  "Decode this menu, I'm hungry",
  "Book it before I change my mind",
  "Which of these is the actual login button?",
  "Turn this wall of text into three bullets",
  "Read this email and tell me if I'm in trouble",
  "Find a coupon code that actually works",
  "Is this a sale or just a red font?",
  "Explain this meme to an old person",
  "Which of these 9 tabs is the same article?",
  "Track down the price before shipping",
  "What did this thread even agree on?",
  "Write the cover letter, I'll take the credit",
  "Who's right in these comments? Pick one",
  "Get me past this paywall, legally",
  "Make this recipe for two, not twelve",
  "Find the cancel button. It exists. Somewhere.",
  "Pretend I'm in the meeting and take notes",
  "Is this charger compatible or am I dreaming?",
  "Fact-check my uncle's link",
  "Explain the plot, I fell asleep",
  "Which of these flights won't ruin my life?",
  "Rate this apartment listing's honesty",
  "Find the email they said they sent",
  "Turn this PDF into something human",
  "Plan my weekend with these 30 tabs",
  "What does this button do? Asking for a friend",
  "Copy this table without breaking everything",
  "Make me sound smart in this reply",
  "Tell me what changed since I last looked",
  "Why is my cart suddenly $40 more?",
  "Dig up the docs nobody linked",
  "Is this a bug or a feature?",
  "Find me a restaurant that's open right now",
  "Untangle this calendar invite chaos",
  "Sort these tabs into things I'll regret",
  "Summarize this before my coffee kicks in",
  "Which of these 400 reviews mention smell?",
  "Explain the release notes, minus the jargon",
  "Fill in my address. Again.",
  "Is this website from 2004? Be gentle",
  "Find the size chart they buried",
  "Tell me the ending so I can stop reading",
  "Compare these three, pick the less bad one",
  "Search this page for the one word I need",
  "Turn these specs into yes or no",
  "Why does every site need a newsletter?",
  "Help me write a polite 'no'",
  "What's the vibe of this subreddit?",
  "Find the actual product under all this marketing",
  "Is this job posting realistic or a unicorn hunt?",
  "Undo whatever I just did here",
  "Read me the highlights, I'm driving my mouse",
  "Find the settings page. Any settings page.",
  "Is it safe to click 'Allow'?",
  "Proofread this before I embarrass myself",
  "Get the gist, skip the hot takes",
  "Find the original source, not the repost",
  "Make this checkout take one click, somehow",
  "Explain what this graph is trying to say",
  "Tell me something useful about this tab",
];

function shufflePlaceholder() {
  input.el.dataset.placeholder = PLACEHOLDERS[Math.floor(Math.random() * PLACEHOLDERS.length)];
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
  slash.update();
  void tabMenu.update();
});
// The caret can leave an @word without typing (arrows, clicks).
document.addEventListener("selectionchange", () => void tabMenu.update());
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
