import type { ModelState } from "../chat";
import { describeWhen, nextRun, type CheckBack, type Job, type JobDraft, type Scheduled, type ScheduleRequest } from "../schedule";

// Jobs and check-backs, in chrome.storage.local, each with a chrome.alarms
// alarm for its next run. Storage is the record; alarms are re-armed from it when
// the browser starts. The background's alarm listener asks `due` whether to
// run a job, and pi-session runs it.

// Pre-release: a new layout gets a new key instead of a migration, so
// records in an older one ("jobs") are never read.
const KEY = "scheduled";
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

// Everything stored: jobs and check-backs.
export async function listScheduled(): Promise<Scheduled[]> {
  const { [KEY]: all = [] } = await chrome.storage.local.get(KEY);
  return all as Scheduled[];
}

// Jobs only: what the Scheduled view and schedule_job list.
export async function scheduledJobs(): Promise<Job[]> {
  return (await listScheduled()).filter((s) => s.kind === "job");
}

async function store(all: Scheduled[]): Promise<void> {
  await chrome.storage.local.set({ [KEY]: all });
}

async function arm(s: Scheduled): Promise<void> {
  if ((s.kind === "job" && s.paused) || s.next === undefined) await chrome.alarms.clear(ALARM + s.id);
  else await chrome.alarms.create(ALARM + s.id, { when: s.next });
}

// What's left of `all` without what `drop` picks, whose alarms are cleared.
async function remove(all: Scheduled[], drop: (s: Scheduled) => boolean): Promise<Scheduled[]> {
  for (const s of all) if (drop(s)) await chrome.alarms.clear(ALARM + s.id);
  return all.filter((s) => !drop(s));
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
export function saveJob(draft: JobDraft): Promise<Job> {
  return inOrder(async () => {
    const all = await listScheduled();
    const old = all.find((s): s is Job => s.kind === "job" && s.id === draft.id);
    const next = nextRun(draft.when, Date.now());
    if (next === undefined) throw new Error("That time has already passed");
    const job: Job = { ...old, ...draft, kind: "job", id: old?.id ?? crypto.randomUUID(), paused: draft.paused ?? old?.paused ?? false, next };
    await store(old ? all.map((s) => (s === old ? job : s)) : [...all, job]);
    await arm(job);
    return job;
  });
}

// Sets `chatId`'s one check-back, replacing any it had, in one step so two
// asked at once can't both stay.
function setCheckBack(chatId: number, note: string, at: number): Promise<CheckBack> {
  return inOrder(async () => {
    if (!(at > Date.now())) throw new Error("That time has already passed");
    const checkBack: CheckBack = { kind: "check_back", id: crypto.randomUUID(), chatId, note, next: at };
    await store([...(await remove(await listScheduled(), (s) => s.kind === "check_back" && s.chatId === chatId)), checkBack]);
    await arm(checkBack);
    return checkBack;
  });
}

export function deleteJob(id: string): Promise<boolean> {
  return inOrder(async () => {
    const all = await listScheduled();
    const left = await remove(all, (s) => s.id === id);
    if (left.length === all.length) return false;
    await store(left);
    return true;
  });
}

// Drops `chatId`'s check-back: the model cancelled it, or the chat was deleted.
export function dropCheckBack(chatId: number): Promise<void> {
  return inOrder(async () => {
    await store(await remove(await listScheduled(), (s) => s.kind === "check_back" && s.chatId === chatId));
  });
}

// An alarm fired: moves its job on to its next run (a one-time job or a
// check-back is done), and returns what should run now. A run missed while
// the browser was closed is skipped, and so is an alarm for a time it has
// since moved from (changed, paused or already run).
export function due(alarm: chrome.alarms.Alarm): Promise<Scheduled | undefined> {
  if (!alarm.name.startsWith(ALARM)) return Promise.resolve(undefined);
  const id = alarm.name.slice(ALARM.length);
  return inOrder(async () => {
    const all = await listScheduled();
    const fired = all.find((s) => s.id === id);
    if (!fired || fired.next !== alarm.scheduledTime) return undefined;
    const missed = alarm.scheduledTime < (await noteBrowserStart());
    const next = fired.kind === "job" && fired.when.kind !== "once" ? nextRun(fired.when, Math.max(Date.now(), alarm.scheduledTime)) : undefined;
    if (next === undefined) {
      await store(all.filter((s) => s !== fired));
    } else {
      const moved = { ...fired, next };
      await store(all.map((s) => (s === fired ? moved : s)));
      await arm(moved);
    }
    return missed || (fired.kind === "job" && fired.paused) ? undefined : fired;
  });
}

// On browser start: alarms may not survive a restart, so each is armed
// again, for its next run from now (runs missed meanwhile are skipped).
export function rearm(): Promise<void> {
  return inOrder(async () => {
    const now = Date.now();
    const all = (await listScheduled()).flatMap((s): Scheduled[] => {
      if (s.next !== undefined && s.next > now) return [s];
      const next = s.kind === "job" ? nextRun(s.when, now) : undefined;
      return next === undefined ? [] : [{ ...s, next }];
    });
    await store(all);
    for (const s of all) await arm(s);
  });
}

// Answers pi's check_back and schedule_job tools, asked from `chatId`'s pi,
// on `model`.
export async function answerTool(request: ScheduleRequest, from: { chatId: number; model: ModelState }): Promise<unknown> {
  switch (request.op) {
    case "check_back": {
      if (!request.note) throw new Error("A check-back needs a note");
      // One per chat: a new one replaces it.
      const checkBack = await setCheckBack(from.chatId, request.note, request.at);
      return { at: new Date(checkBack.next).toString() };
    }
    case "cancel_check_back":
      await dropCheckBack(from.chatId);
      return { cancelled: true };
    case "create": {
      const { title, prompt, when } = request.job;
      if (!title || !prompt || !when) throw new Error("A job needs a title, a prompt and when to run");
      return summary(await saveJob({ title, prompt, when, model: from.model.current, thinkingLevel: from.model.thinkingLevel }));
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
