import { el } from "./dom";

// A row in the list. `divider` draws a line above it.
export type Option = { name: string; description?: string; icon?: string; divider?: boolean };

// A list that opens above the composer while the user types (commands,
// tabs). The arrows move through it, Enter or Tab picks, Escape closes.
export class Dropup {
  private count = 0;
  private index = 0;
  private pick: (index: number) => void = () => {};

  constructor(private readonly list: HTMLElement) {
    // Keep focus in the composer while clicking a row.
    list.addEventListener("mousedown", (e) => e.preventDefault());
  }

  show(options: Option[], pick: (index: number) => void) {
    if (!options.length) return this.close();
    this.count = options.length;
    this.index = Math.min(this.index, this.count - 1);
    this.pick = pick;
    this.list.replaceChildren(
      ...options.flatMap((option, i) => {
        const row = el("div", "dropup-item");
        row.setAttribute("role", "option");
        if (option.icon) {
          const icon = row.appendChild(el("img", "dropup-icon"));
          icon.src = option.icon;
          icon.alt = "";
        }
        row.append(el("span", "dropup-name", option.name), el("span", "dropup-desc", option.description ?? ""));
        row.addEventListener("click", () => this.choose(i));
        row.addEventListener("mousemove", () => {
          if (this.index !== i) {
            this.index = i;
            this.highlight();
          }
        });
        return option.divider ? [el("div", "dropup-divider"), row] : [row];
      }),
    );
    this.list.hidden = false;
    this.highlight();
  }

  close() {
    this.list.hidden = true;
    this.index = 0;
  }

  // Handles a key in the composer; returns true when the list used it.
  keydown(e: KeyboardEvent): boolean {
    if (this.list.hidden || e.isComposing) return false;
    switch (e.key) {
      case "ArrowDown":
      case "ArrowUp":
        this.index = (this.index + (e.key === "ArrowDown" ? 1 : -1) + this.count) % this.count;
        this.highlight();
        break;
      case "Enter":
      case "Tab":
        if (e.shiftKey) return false;
        this.choose(this.index);
        break;
      case "Escape":
        this.close();
        break;
      default:
        return false;
    }
    e.preventDefault();
    e.stopPropagation();
    return true;
  }

  private choose(index: number) {
    this.close();
    this.pick(index);
  }

  private highlight() {
    const rows = this.list.querySelectorAll(".dropup-item");
    rows.forEach((row, i) => row.setAttribute("aria-selected", String(i === this.index)));
    rows[this.index]?.scrollIntoView({ block: "nearest" });
  }
}
