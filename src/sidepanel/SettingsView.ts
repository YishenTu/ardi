import type { PiCheck } from "../shared";
import { askSettings } from "./pi";

// The settings screen, over the chat. The background owns the settings; this
// shows them and asks for changes. A field saves when it's committed (Enter
// or leaving it), once it checks out.
export class SettingsView {
  private readonly path: HTMLInputElement;
  private readonly status: HTMLElement;
  private readonly version: HTMLElement;
  private readonly toggle: HTMLElement;
  private readonly pathRow: HTMLElement;
  private saved = "";

  constructor(private readonly root: HTMLElement) {
    this.path = root.querySelector("#pi-path")!;
    this.status = root.querySelector("#pi-check")!;
    this.version = root.querySelector("#pi-version")!;
    this.toggle = root.querySelector("#pi-toggle")!;
    this.pathRow = root.querySelector("#pi-path-row")!;
    this.toggle.addEventListener("click", () => this.expand(this.toggle.getAttribute("aria-expanded") !== "true"));
    this.path.addEventListener("change", () => void this.commitPath());
    this.path.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.path.blur();
    });
    root.querySelector("#settings-close")!.addEventListener("click", () => this.close());
    root.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.close();
    });
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  // The field stays disabled until the saved path arrives, so nothing typed
  // meanwhile gets overwritten.
  async open() {
    this.root.hidden = false;
    this.path.disabled = true;
    const { settings, check } = await askSettings({ kind: "get_settings" });
    this.saved = this.path.value = settings.piPath;
    this.path.disabled = false;
    this.show(check);
  }

  close() {
    this.root.hidden = true;
  }

  // Saving a working path also restarts pi (the background does both).
  private async commitPath() {
    const value = this.path.value.trim();
    this.path.value = value;
    if (value === this.saved) return;
    this.status.dataset.state = "";
    this.status.textContent = "Checking…";
    const { saved, check } = await askSettings({ kind: "set_pi_path", piPath: value });
    if (saved) this.saved = value;
    this.show(check);
  }

  // The CLI path sits folded under the Pi row; it opens with the row, or by
  // itself when Pi doesn't run, so the error under it shows.
  private expand(open: boolean) {
    this.pathRow.hidden = !open;
    this.toggle.setAttribute("aria-expanded", String(open));
    if (open) this.path.focus();
  }

  // A working Pi shows its version by the name; a failed check shows why
  // under the path.
  private show(check: PiCheck) {
    if (check.error) this.expand(true);
    // With no path set, the installed Pi is the default.
    if (!this.path.value) this.path.placeholder = check.command;
    this.status.dataset.state = check.error ? "error" : "";
    this.status.textContent = check.error ?? "";
    if (check.version) this.version.textContent = check.version;
  }
}
