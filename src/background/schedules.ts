import type { ModelState } from "../chat";
import { describeWhen, nextRun, type Job, type JobDraft, type ScheduleRequest } from "../schedule";

// Scheduled jobs, in chrome.storage.local, each with a chrome.alarms alarm
// for its next run. Storage is the record; alarms are re-armed from it when
// the browser starts. The background's alarm listener asks `due` whether to
// run a job, and pi-session runs it.

const KEY = "jobs";
const ALARM = "job:";
// When this browser session started, in chrome.storage.session (cleared when
// the browser quits). A run due before then was missed while it was closed.
const BROWSER_START = "browserStart";

// Changes run one at a time, so two can't overwrite each other's list.
let queue: Promise<unknown> = Promise.resolve();
function inOrder<T>(run: () => Promise<T>): Promise<T> {
  const done = queue.then(run);
  queue = done.catch(() => undefined);
  return done;
}

export async function listJobs(): Promise<Job[]> {
  const { [KEY]: jobs = [] } = await chrome.storage.local.get(KEY);
  return jobs as Job[];
}

// Jobs only, without check-backs: what the Scheduled view and schedule_job list.
export async function scheduledJobs(): Promise<Job[]> {
  return (await listJobs()).filter((j) => j.chatId === undefined);
}

async function setJobs(jobs: Job[]): Promise<void> {
  await chrome.storage.local.set({ [KEY]: jobs });
}

async function arm(job: Job): Promise<void> {
  if (job.paused || job.next === undefined) await chrome.alarms.clear(ALARM + job.id);
  else await chrome.alarms.create(ALARM + job.id, { when: job.next });
}

// Records the browser session's start the first time the worker asks.
export async function noteBrowserStart(): Promise<number> {
  const { [BROWSER_START]: started } = await chrome.storage.session.get(BROWSER_START);
  if (typeof started === "number") return started;
  const now = Date.now();
  await chrome.storage.session.set({ [BROWSER_START]: now });
  return now;
}

// Creates a job, or updates the one with `draft.id`, and arms its next run.
// Refuses a time that has already passed: the job would never run.
export function saveJob(draft: JobDraft & { chatId?: number }): Promise<Job> {
  return inOrder(async () => {
    const jobs = await listJobs();
    const job = build(jobs, draft);
    const old = jobs.find((j) => j.id === job.id);
    await setJobs(old ? jobs.map((j) => (j === old ? job : j)) : [...jobs, job]);
    await arm(job);
    return job;
  });
}

function build(jobs: Job[], draft: JobDraft & { chatId?: number }): Job {
  const old = jobs.find((j) => j.id === draft.id);
  const next = nextRun(draft.when, Date.now());
  if (next === undefined) throw new Error("That time has already passed");
  return { ...old, ...draft, id: old?.id ?? crypto.randomUUID(), paused: draft.paused ?? old?.paused ?? false, next };
}

// Sets `chatId`'s one check-back, replacing any it had, in one step so two
// asked at once can't both stay.
function setCheckBack(chatId: number, draft: JobDraft): Promise<Job> {
  return inOrder(async () => {
    const jobs = await listJobs();
    const job = build(jobs, { ...draft, chatId });
    const dropped = jobs.filter((j) => j.chatId === chatId);
    await setJobs([...jobs.filter((j) => j.chatId !== chatId), job]);
    for (const j of dropped) await chrome.alarms.clear(ALARM + j.id);
    await arm(job);
    return job;
  });
}

export function deleteJob(id: string): Promise<boolean> {
  return inOrder(async () => {
    const jobs = await listJobs();
    if (!jobs.some((j) => j.id === id)) return false;
    await setJobs(jobs.filter((j) => j.id !== id));
    await chrome.alarms.clear(ALARM + id);
    return true;
  });
}

// Deleting a chat drops the check-back waiting on it.
export function dropCheckBacks(chatId: number): Promise<void> {
  return inOrder(async () => {
    const jobs = await listJobs();
    const dropped = jobs.filter((j) => j.chatId === chatId);
    if (!dropped.length) return;
    await setJobs(jobs.filter((j) => j.chatId !== chatId));
    for (const j of dropped) await chrome.alarms.clear(ALARM + j.id);
  });
}

// A job's alarm fired: moves it on to its next run (a one-time job is done),
// and returns it if it should run now. A run missed while the browser was
// closed is skipped, and so is an alarm for a time the job has since moved
// from (changed, or already run).
export function due(alarm: chrome.alarms.Alarm): Promise<Job | undefined> {
  if (!alarm.name.startsWith(ALARM)) return Promise.resolve(undefined);
  const id = alarm.name.slice(ALARM.length);
  return inOrder(async () => {
    const jobs = await listJobs();
    const job = jobs.find((j) => j.id === id);
    if (!job || job.next !== alarm.scheduledTime) return undefined;
    const missed = alarm.scheduledTime < (await noteBrowserStart());
    const next = job.when.kind === "once" ? undefined : nextRun(job.when, Math.max(Date.now(), alarm.scheduledTime));
    if (next === undefined) {
      await setJobs(jobs.filter((j) => j !== job));
    } else {
      await setJobs(jobs.map((j) => (j === job ? { ...job, next } : j)));
      await arm({ ...job, next });
    }
    return missed || job.paused ? undefined : job;
  });
}

// On browser start: alarms may not survive a restart, so each job is armed
// again, for its next run from now (runs missed meanwhile are skipped).
export function rearm(): Promise<void> {
  return inOrder(async () => {
    const now = Date.now();
    const jobs = (await listJobs()).flatMap((j) => {
      const next = j.next !== undefined && j.next > now ? j.next : nextRun(j.when, now);
      return next === undefined ? [] : [{ ...j, next }];
    });
    await setJobs(jobs);
    for (const j of jobs) await arm(j);
  });
}

// Answers pi's check_back and schedule_job tools, asked from `chatId`'s pi,
// on `model`.
export async function answerTool(request: ScheduleRequest, from: { chatId: number; model: ModelState }): Promise<unknown> {
  const model = { model: from.model.current, thinkingLevel: from.model.thinkingLevel };
  switch (request.op) {
    case "check_back": {
      if (!request.note) throw new Error("A check-back needs a note");
      // One per chat: a new one replaces it.
      const job = await setCheckBack(from.chatId, { title: request.note.slice(0, 60), prompt: request.note, when: { kind: "once", at: request.at }, ...model });
      return { at: new Date(job.next!).toString() };
    }
    case "cancel_check_back":
      await dropCheckBacks(from.chatId);
      return { cancelled: true };
    case "create": {
      const { title, prompt, when } = request.job;
      if (!title || !prompt || !when) throw new Error("A job needs a title, a prompt and when to run");
      return summary(await saveJob({ title, prompt, when, ...model }));
    }
    case "list":
      return (await scheduledJobs()).map(summary);
    case "cancel": {
      const job = (await scheduledJobs()).find((j) => j.id === request.id);
      if (!job) throw new Error(`No scheduled job with id ${request.id}`);
      await deleteJob(job.id);
      return { cancelled: job.id };
    }
    default:
      throw new Error("Unknown schedule operation");
  }
}

function summary(job: Job) {
  return {
    id: job.id,
    title: job.title,
    when: describeWhen(job.when),
    next: job.next === undefined ? null : new Date(job.next).toString(),
    paused: job.paused,
  };
}
