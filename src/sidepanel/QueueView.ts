import type { QueueAction, QueuedMessage } from "../chat";
import { plainMentions } from "../mention";
import { el } from "./dom";

const STEERING_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 3v4.5a2 2 0 0 0 2 2h6.5M10 7l2.5 2.5L10 12" /></svg>';
const WAITING_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.5" /><path d="M8 5v3l2 1.5" /></svg>';
const EDIT_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10.5 3.5l2 2L6 12H4v-2z" /></svg>';
const REMOVE_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" /></svg>';

// Messages waiting for pi while it works, at the top of the message box,
// each with buttons to steer it (pi takes it after its current step), take
// it back to the box to edit, or remove it.
export class QueueView {
  constructor(
    private readonly tray: HTMLElement,
    private readonly act: (action: QueueAction) => void,
  ) {}

  render(queue: QueuedMessage[]) {
    this.tray.hidden = !queue.length;
    this.tray.replaceChildren(...queue.map((message, index) => this.row(message, index)));
  }

  private row({ text, steer }: QueuedMessage, index: number): HTMLElement {
    const row = el("div", `queued${steer ? " steering" : ""}`);
    const icon = row.appendChild(el("span", "queued-icon"));
    icon.innerHTML = steer ? STEERING_ICON : WAITING_ICON;
    // Text from the user; a message of only images has none (pi gets a space).
    row.append(el("span", "queued-text", plainMentions(text).trim() || "Image"));
    if (steer) row.append(el("span", "queued-when", "Steering"));
    else {
      const button = row.appendChild(el("button", "queued-steer", "Steer"));
      button.type = "button";
      button.title = "Send after the current step (⌘↵)";
      button.addEventListener("click", () => this.act({ action: "steer", index, text }));
    }
    row.append(
      iconButton("queued-edit", "Edit in the message box", EDIT_ICON, () => this.act({ action: "edit", index, text })),
      iconButton("queued-remove", "Remove", REMOVE_ICON, () => this.act({ action: "remove", index, text })),
    );
    return row;
  }
}

function iconButton(className: string, label: string, icon: string, click: () => void): HTMLButtonElement {
  const button = el("button", `queued-icon-btn ${className}`);
  button.type = "button";
  button.title = label;
  button.setAttribute("aria-label", label);
  button.innerHTML = icon;
  button.addEventListener("click", click);
  return button;
}
