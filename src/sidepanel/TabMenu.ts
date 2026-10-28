import type { TabMention } from "../mention";
import type { Composer } from "./Composer";
import { favicon, host } from "./dom";
import { Dropup } from "./Dropup";

// "@" at the start of a word, and what's typed after it.
const TRIGGER = /(?:^|\s)@([^\s@]*)$/;

// The list of open tabs that opens above the composer on "@". Picking one
// puts it in the message as a chip.
export class TabMenu {
  private readonly menu: Dropup;
  // The open tabs, read when the list opens and kept until it closes.
  private tabs: Promise<TabMention[]> | null = null;

  constructor(
    private readonly input: Composer,
    list: HTMLElement,
  ) {
    this.menu = new Dropup(list);
  }

  // Opens, filters or closes the list from the word at the caret.
  async update() {
    if (!TRIGGER.test(this.input.beforeCaret())) {
      this.tabs = null;
      return this.menu.close();
    }
    this.tabs ??= openTabs();
    const tabs = await this.tabs;
    // The user may have typed on while the tabs loaded.
    const match = TRIGGER.exec(this.input.beforeCaret());
    if (!match) return;
    const query = match[1].toLowerCase();
    const matches = tabs.filter((t) => t.title.toLowerCase().includes(query) || t.url.toLowerCase().includes(query));
    this.menu.show(
      matches.map((t) => ({ name: t.title, description: host(t.url), icon: favicon(t.url) })),
      (i) => this.input.insertTab(matches[i], query.length + 1),
    );
  }

  // Handles a key in the composer; returns true when the list used it.
  keydown(e: KeyboardEvent): boolean {
    return this.menu.keydown(e);
  }
}

// Web page tabs (what pi's tools can reach), most recently used first.
async function openTabs(): Promise<TabMention[]> {
  const tabs = await chrome.tabs.query({});
  return tabs
    .filter((t) => /^https?:/.test(t.url ?? ""))
    .sort((a, b) => b.lastAccessed - a.lastAccessed)
    .map((t) => ({ title: t.title || t.url!, url: t.url! }));
}
