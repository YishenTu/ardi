import type { ImageAttachment } from "../chat";
import type { TabMention } from "../mention";

// Small DOM helpers shared by the panel's views.

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

const TRASH_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 4.5h9M6.5 4.5V3h3v1.5M5 4.5l.5 8h5l.5-8" /></svg>';

// A trash button for a row: the first click arms it ("Delete"), the second
// deletes. Leaving it disarms it. Clicks don't reach the row.
export function deleteButton(className: string, title: string, confirmed: () => void): HTMLButtonElement {
  const button = el("button", className);
  button.type = "button";
  button.title = title;
  button.innerHTML = TRASH_ICON;
  button.addEventListener("click", (e) => {
    e.stopPropagation();
    if (button.classList.contains("armed")) return confirmed();
    button.classList.add("armed");
    button.textContent = "Delete";
  });
  button.addEventListener("mouseleave", () => {
    if (!button.classList.contains("armed")) return;
    button.classList.remove("armed");
    button.innerHTML = TRASH_ICON;
  });
  return button;
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

export function imageUrl(image: ImageAttachment): string {
  return `data:${image.mimeType};base64,${image.data}`;
}
