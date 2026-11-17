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
    if (req.kind === "save_job") {
      const job: Job = { paused: false, ...req.job, id: req.job.id ?? `j${jobs.length + 1}`, next: Date.now() + 1000 };
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
  jobs = [{ id: "j1", title: "Invoice check", prompt: "find invoices", when: { kind: "weekdays", time: "09:00" }, model: { provider: "p", id: "haiku" }, thinkingLevel: "low", paused: false }];
  background();
  view = new ScheduleView($("schedule"), () => MODELS);
});

describe("Scheduled view", () => {
  test("lists each job by title with when, model and effort in words", async () => {
    await view.open();
    expect(rows()).toHaveLength(1);
    expect(rows()[0].textContent).toContain("Invoice check");
    expect(rows()[0].textContent).toContain("Weekdays 09:00 · Haiku 5.5 · Low");
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
    rows()[0].querySelector<HTMLButtonElement>(".job-delete")!.click();
    rows()[0].querySelector<HTMLButtonElement>(".job-delete")!.click();
    await waitFor(() => expect(jobs).toEqual([]));
  });

  test("a job missing its title or prompt isn't saved", async () => {
    await view.open();
    $("job-new").click();
    field<HTMLInputElement>("job-title").value = "No prompt";
    $("job-save").click();
    expect(asked.some((r) => r.kind === "save_job")).toBe(false);
  });
});
