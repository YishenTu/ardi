import type { ModelState, ThinkingLevel } from "../chat";
import { describeWhen, type Job, type JobDraft, type When } from "../schedule";
import { deleteButton, el } from "./dom";
import { LEVEL_NAMES } from "./ModelPicker";
import { askBackground } from "./pi";

const KINDS: { kind: When["kind"]; label: string }[] = [
  { kind: "once", label: "Once" },
  { kind: "hourly", label: "Hourly" },
  { kind: "daily", label: "Daily" },
  { kind: "weekdays", label: "Weekdays" },
  { kind: "weekly", label: "Weekly" },
];
const DAYS = ["M", "Tu", "W", "Th", "F", "Sa", "Su"];
// DAYS' order (Monday first) to Date's day numbers (Sunday 0).
const DAY_NUMBERS = [1, 2, 3, 4, 5, 6, 0];

const PAUSE_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4.5v7M10 4.5v7" /></svg>';
const RESUME_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5.5 4 11.5 8l-6 4z" /></svg>';

const pad = (n: number) => String(n).padStart(2, "0");
const dateValue = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const timeValue = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const modelKey = (m?: { provider: string; id: string }) => (m ? `${m.provider}/${m.id}` : "");

// The Scheduled screen, over the chat: the list of jobs, and the form that
// creates or edits one. The background owns the jobs; this shows them and
// asks for changes. `models` is what pi last reported, for the model picker.
export class ScheduleView {
  private readonly list: HTMLElement;
  private readonly listView: HTMLElement;
  private readonly form: HTMLFormElement;
  private readonly heading: HTMLElement;
  private readonly newButton: HTMLElement;
  private readonly pauseButton: HTMLButtonElement;
  private readonly deleteButton: HTMLButtonElement;
  private readonly title: HTMLInputElement;
  private readonly prompt: HTMLTextAreaElement;
  private readonly kinds: HTMLElement;
  private readonly days: HTMLElement;
  private readonly date: HTMLInputElement;
  private readonly time: HTMLInputElement;
  private readonly every: HTMLInputElement;
  private readonly model: HTMLSelectElement;
  private readonly effort: HTMLElement;
  private readonly error: HTMLElement;
  private jobs: Job[] = [];
  // The job the form edits; undefined for a new one.
  private editing: Job | undefined;
  private kind: When["kind"] = "daily";
  private level: ThinkingLevel | undefined;

  constructor(private readonly root: HTMLElement, private readonly models: () => ModelState) {
    const $ = <T extends HTMLElement>(id: string) => root.querySelector<T>(`#${id}`)!;
    this.list = $("job-list");
    this.listView = $("job-list-view");
    this.form = $("job-form");
    this.heading = $("schedule-heading");
    this.newButton = $("job-new");
    this.pauseButton = $("job-pause");
    this.deleteButton = $("job-delete");
    this.title = $("job-title");
    this.prompt = $("job-prompt");
    this.kinds = $("job-kind");
    this.days = $("job-days");
    this.date = $("job-date");
    this.time = $("job-time");
    this.every = $("job-every");
    this.model = $("job-model");
    this.effort = $("job-effort");
    this.error = $("job-error");

    for (const { kind, label } of KINDS) this.kinds.append(this.radio(label, () => this.setKind(kind)));
    for (const label of DAYS) {
      const day = this.days.appendChild(this.radio(label, () => day.setAttribute("aria-checked", String(day.getAttribute("aria-checked") !== "true"))));
    }
    this.model.addEventListener("change", () => this.renderEffort());
    this.newButton.addEventListener("click", () => this.edit(undefined));
    this.pauseButton.addEventListener("click", () => this.editing && void this.togglePause(this.editing));
    this.deleteButton.addEventListener("click", () => this.editing && void this.remove(this.editing.id).then(() => this.showList()));
    this.form.addEventListener("submit", (e) => {
      e.preventDefault();
      void this.save();
    });
    $("schedule-back").addEventListener("click", () => {
      if (this.form.hidden) this.close();
      else void this.showList();
    });
    root.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      // Esc closes this screen only; it must not reach the chat's Stop.
      e.stopPropagation();
      this.close();
    });
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  async open() {
    this.root.hidden = false;
    await this.showList();
  }

  // Opens straight to a new job.
  async create() {
    await this.open();
    this.edit(undefined);
  }

  close() {
    this.root.hidden = true;
  }

  private async showList() {
    this.form.hidden = true;
    this.listView.hidden = false;
    this.heading.textContent = "Scheduled";
    this.newButton.hidden = false;
    this.pauseButton.hidden = this.deleteButton.hidden = true;
    this.jobs = (await askBackground({ kind: "list_jobs" })).jobs;
    this.renderList();
  }

  private renderList() {
    this.list.hidden = !this.jobs.length;
    this.list.replaceChildren(...this.jobs.map((job) => this.row(job)));
  }

  private row(job: Job): HTMLElement {
    const row = el("div", `row job${job.paused ? " paused" : ""}`);
    row.addEventListener("click", () => this.edit(job));
    const text = row.appendChild(el("div", "row-text"));
    text.append(el("span", "row-name", job.title), el("span", "row-desc", this.summary(job)));
    const actions = row.appendChild(el("div", "job-actions"));
    const pause = actions.appendChild(el("button", "icon-btn"));
    pause.type = "button";
    pause.title = job.paused ? "Resume" : "Pause";
    pause.innerHTML = job.paused ? RESUME_ICON : PAUSE_ICON;
    pause.addEventListener("click", (e) => {
      e.stopPropagation();
      void this.togglePause(job);
    });
    actions.append(deleteButton("chat-delete job-delete", "Delete job", () => void this.remove(job.id).then(() => this.showList())));
    return row;
  }

  // "Weekdays 09:00 · Opus 5.5 · High"
  private summary(job: Job): string {
    const model = job.model && (this.models().models.find((m) => modelKey(m) === modelKey(job.model))?.name ?? job.model.id);
    return [describeWhen(job.when), model, job.thinkingLevel && LEVEL_NAMES[job.thinkingLevel]].filter(Boolean).join(" · ");
  }

  // A job that can't resume (its one time has passed) opens with the reason.
  private async togglePause(job: Job) {
    const { error } = await askBackground({ kind: "save_job", job: { ...draftOf(job), paused: !job.paused } });
    if (!error) return this.showList();
    this.edit(job);
    this.error.textContent = error;
  }

  private remove(id: string) {
    return askBackground({ kind: "delete_job", id });
  }

  // Fills the form with `job`, or a new job's defaults: daily at 9, on the
  // model and effort the current chat is on.
  private edit(job: Job | undefined) {
    this.editing = job;
    this.error.textContent = "";
    this.listView.hidden = true;
    this.form.hidden = false;
    this.heading.textContent = job ? "Job" : "New job";
    this.newButton.hidden = true;
    this.pauseButton.hidden = this.deleteButton.hidden = !job;
    if (job) {
      this.pauseButton.title = job.paused ? "Resume" : "Pause";
      this.pauseButton.innerHTML = job.paused ? RESUME_ICON : PAUSE_ICON;
    }
    this.form.querySelector<HTMLButtonElement>("#job-save")!.textContent = job ? "Save" : "Create";

    const state = this.models();
    const when = job?.when ?? { kind: "daily", time: "09:00" };
    const soon = new Date(Date.now() + 3_600_000);
    this.title.value = job?.title ?? "";
    this.prompt.value = job?.prompt ?? "";
    this.date.value = dateValue(when.kind === "once" ? new Date(when.at) : soon);
    this.time.value = when.kind === "once" ? timeValue(new Date(when.at)) : "time" in when ? when.time : "09:00";
    this.every.value = String(when.kind === "hourly" ? when.every : 1);
    const days = when.kind === "weekly" ? when.days : [];
    [...this.days.children].forEach((b, i) => b.setAttribute("aria-checked", String(days.includes(DAY_NUMBERS[i]))));
    this.setKind(when.kind);

    this.model.replaceChildren(...state.models.map((m) => new Option(m.name, modelKey(m))));
    this.model.value = modelKey(job ? job.model : state.current);
    this.level = job ? job.thinkingLevel : state.thinkingLevel;
    this.renderEffort();
    this.title.focus();
  }

  private setKind(kind: When["kind"]) {
    this.kind = kind;
    [...this.kinds.children].forEach((b, i) => b.setAttribute("aria-checked", String(KINDS[i].kind === kind)));
    this.days.hidden = kind !== "weekly";
    this.date.closest<HTMLElement>(".field-row")!.hidden = kind !== "once";
    this.every.closest<HTMLElement>(".field-row")!.hidden = kind !== "hourly";
    this.time.closest<HTMLElement>(".field-row")!.hidden = kind === "hourly";
  }

  // The selected model's effort levels, keeping the chosen one if it has it.
  private renderEffort() {
    const model = this.models().models.find((m) => modelKey(m) === this.model.value);
    const levels = model?.thinkingLevels ?? [];
    if (this.level && !levels.includes(this.level)) this.level = levels[0];
    this.effort.hidden = !levels.some((l) => l !== "off");
    this.effort.replaceChildren(
      ...levels.map((level) => {
        const button = this.radio(LEVEL_NAMES[level], () => {
          this.level = level;
          this.renderEffort();
        });
        button.setAttribute("aria-checked", String(level === this.level));
        return button;
      }),
    );
  }

  private when(): When | undefined {
    const time = this.time.value;
    switch (this.kind) {
      case "once": {
        const at = new Date(`${this.date.value}T${time}`).getTime();
        return Number.isNaN(at) ? undefined : { kind: "once", at };
      }
      case "hourly": {
        const every = Math.max(1, Math.round(Number(this.every.value) || 1));
        const old = this.editing?.when;
        return { kind: "hourly", every, from: old?.kind === "hourly" ? old.from : Date.now() };
      }
      case "weekly": {
        const days = [...this.days.children].flatMap((b, i) => (b.getAttribute("aria-checked") === "true" ? [DAY_NUMBERS[i]] : []));
        return days.length && time ? { kind: "weekly", days, time } : undefined;
      }
      case "daily":
      case "weekdays":
        return time ? { kind: this.kind, time } : undefined;
    }
  }

  private async save() {
    const title = this.title.value.trim();
    const prompt = this.prompt.value.trim();
    const when = this.when();
    if (!title) return this.title.focus();
    if (!prompt) return this.prompt.focus();
    if (!when) return;
    const [provider, ...id] = this.model.value.split("/");
    const job: JobDraft = {
      ...(this.editing && { id: this.editing.id }),
      title,
      prompt,
      when,
      ...(provider && { model: { provider, id: id.join("/") } }),
      ...(this.level && { thinkingLevel: this.level }),
    };
    const { error } = await askBackground({ kind: "save_job", job });
    this.error.textContent = error ?? "";
    if (!error) await this.showList();
  }

  private radio(label: string, pick: () => void): HTMLButtonElement {
    const button = el("button", "", label);
    button.type = "button";
    button.setAttribute("role", "radio");
    button.setAttribute("aria-checked", "false");
    button.addEventListener("click", pick);
    return button;
  }
}

function draftOf(job: Job): JobDraft {
  const { title, prompt, when, model, thinkingLevel, id, paused } = job;
  return { id, title, prompt, when, model, thinkingLevel, paused };
}
