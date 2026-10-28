import type { TabMention } from "../mention";

// Small DOM helpers shared by the panel's views.

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

// A collapsed row in a reply (thinking or a tool call) that expands to its
// `.step-body`. `.step-arg` is a short line after the label (hidden when empty).
export function step(kind: string, label: string): HTMLDetailsElement {
  const details = el("details", `step ${kind}`);
  const summary = details.appendChild(el("summary"));
  summary.append(el("span", "glyph"), el("span", "step-label", label), el("span", "step-arg"));
  details.append(el("div", "step-body"));
  return details;
}

// A mentioned tab: its icon and title. Chrome serves the icon (the
// `favicon` permission), so it works for tabs that have since closed.
export function tabChip<K extends "a" | "span">(tag: K, tab: TabMention): HTMLElementTagNameMap[K] {
  const chip = el(tag, "tab-chip");
  chip.title = tab.url;
  const icon = chip.appendChild(el("img"));
  icon.src = favicon(tab.url);
  icon.alt = "";
  chip.append(el("span", "", tab.title || host(tab.url)));
  return chip;
}

// Makes the link open `url` in a new tab instead of navigating the panel.
export function opensTab(link: HTMLAnchorElement, url: string): void {
  link.href = url;
  link.target = "_blank";
  link.rel = "noreferrer";
}

export function favicon(url: string): string {
  return chrome.runtime.getURL(`/_favicon/?pageUrl=${encodeURIComponent(url)}&size=32`);
}

export function host(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}
