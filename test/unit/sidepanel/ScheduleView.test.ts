import { beforeEach, describe, expect, test } from "bun:test";

import { chromeFake } from "../../support/chrome";
import { $, loadPanel } from "../../support/panel";
import { waitFor } from "../../support/wait";
import type { ModelState } from "../../../src/chat";
import type { PanelQuestion } from "../../../src/panel-protocol";
import type { Job } from "../../../src/schedule";
import { ScheduleView } from "../../../src/sidepanel/ScheduleView";

const MODELS: ModelState = {
  models: [
    { provider: "p", id: "opus", name: "Opus 5.5", thinkingLevels: ["off", "low", "high"] },
    { provider: "p", id: "haiku", name: "Haiku 5.5", thinkingLevels: ["off", "low"] },
  ],
  current: { provider: "p", id: "opus" },
  thinkingLevel: "high",
};

// The background, keeping jobs as it would.
let jobs: Job[];
let asked: PanelQuestion[];
function background() {
  asked = [];
  chromeFake.onSendMessage = async (req: PanelQuestion) => {
    asked.push(req);
    if (req.kind === "list_jobs") return { jobs };
    if (req.kind === "save_job" && req.job.when.kind === "once" && req.job.when.at < Date.now()) return { error: "That time has already passed" };
    if (req.kind === "save_job") {
      const job: Job = { kind: "job", paused: false, ...req.job, id: req.job.id ?? `j${jobs.length + 1}`, next: Date.now() + 1000 };
      jobs = [...jobs.filter((j) => j.id !== job.id), job];
      return { job };
    }
    if (req.kind === "delete_job") {
      jobs = jobs.filter((j) => j.id !== req.id);
      return { deleted: true };
    }
  };
}

let view: ScheduleView;
const rows = () => [...$("job-list").querySelectorAll<HTMLElement>(".job")];
const field = <T extends HTMLElement>(id: string) => $<T>(id);
const choose = (group: string, label: string) =>
  [...$(group).querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === label)!.click();

beforeEach(() => {
  loadPanel();
  jobs = [{ kind: "job", id: "j1", title: "Invoice check", prompt: "find invoices", when: { kind: "weekdays", time: "09:00" }, model: { provider: "p", id: "haiku" }, thinkingLevel: "low", paused: false, next: Date.now() + 1000 }];
  background();
  view = new ScheduleView($("schedule"), () => MODELS);
});

describe("Scheduled view", () => {
  test("lists each job as a card: title, when in words, its prompt, and model and effort", async () => {
    await view.open();
    expect(rows()).toHaveLength(1);
    const text = (cls: string) => [...rows()[0].querySelectorAll(cls)].map((n) => n.textContent);
    expect(text(".row-name")).toEqual(["Invoice check"]);
    expect(text(".job-when")).toEqual(["Weekdays 09:00"]);
    expect(text(".job-prompt")).toEqual(["find invoices"]);
    expect(text(".chip")).toEqual(["Haiku 5.5", "Low"]);
  });

  test("a job's switch pauses and resumes it from the list, without opening it", async () => {
    await view.open();
    const toggle = () => rows()[0].querySelector<HTMLButtonElement>("[role=switch]")!;
    expect(toggle().getAttribute("aria-checked")).toBe("true");
    toggle().click();
    await waitFor(() => expect(toggle().getAttribute("aria-checked")).toBe("false"));
    expect(jobs[0].paused).toBe(true);
    expect($("job-form").hidden).toBe(true);
    toggle().click();
    await waitFor(() => expect(jobs[0].paused).toBe(false));
  });

  test("a new job defaults to the current model and effort, and saves what the user filled in", async () => {
    await view.open();
    $("job-new").click();
    field<HTMLInputElement>("job-title").value = "Digest";
    field<HTMLTextAreaElement>("job-prompt").value = "summarize my reading list";
    choose("job-kind", "Weekly");
    choose("job-days", "Su");
    field<HTMLInputElement>("job-time").value = "18:00";
    expect(field<HTMLSelectElement>("job-model").value).toBe("p/opus");
    $("job-save").click();
    await waitFor(() => expect(asked.at(-1)?.kind).toBe("list_jobs"));
    expect(asked.find((r) => r.kind === "save_job")).toEqual({
      kind: "save_job",
      job: { title: "Digest", prompt: "summarize my reading list", when: { kind: "weekly", days: [0], time: "18:00" }, model: { provider: "p", id: "opus" }, thinkingLevel: "high" },
    });
    expect(rows()).toHaveLength(2);
  });

  test("clicking a job opens it to edit; pausing and deleting act on it", async () => {
    await view.open();
    rows()[0].click();
    expect(field<HTMLInputElement>("job-title").value).toBe("Invoice check");
    expect(field<HTMLSelectElement>("job-model").value).toBe("p/haiku");
    $("job-pause").click();
    await waitFor(() => expect(jobs[0].paused).toBe(true));
    rows()[0].click();
    $("job-delete").click();
    await waitFor(() => expect(jobs).toEqual([]));
    expect($("job-form").hidden).toBe(true);
  });

  test("a job missing its title or prompt isn't saved", async () => {
    await view.open();
    $("job-new").click();
    field<HTMLInputElement>("job-title").value = "No prompt";
    $("job-save").click();
    expect(asked.some((r) => r.kind === "save_job")).toBe(false);
  });

  test("a job the background refuses stays in the form with the reason", async () => {
    await view.open();
    $("job-new").click();
    field<HTMLInputElement>("job-title").value = "Late";
    field<HTMLTextAreaElement>("job-prompt").value = "x";
    choose("job-kind", "Once");
    field<HTMLInputElement>("job-date").value = "2020-01-01";
    field<HTMLInputElement>("job-time").value = "09:00";
    $("job-save").click();
    await waitFor(() => expect($("job-error").textContent).toBe("That time has already passed"));
    expect($("job-form").hidden).toBe(false);
  });

  test("a job the background refuses to resume opens with the reason", async () => {
    jobs = [{ kind: "job", id: "j1", title: "Renew", prompt: "renew", when: { kind: "once", at: Date.now() - 60_000 }, paused: true, next: Date.now() - 60_000 }];
    await view.open();
    rows()[0].querySelector<HTMLButtonElement>("[role=switch]")!.click();
    await waitFor(() => expect($("job-error").textContent).toBe("That time has already passed"));
    expect($("job-form").hidden).toBe(false);
    expect(field<HTMLInputElement>("job-title").value).toBe("Renew");
  });
});
