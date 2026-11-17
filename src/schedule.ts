// Scheduled jobs, shared by the background (which stores and runs them), the
// panel (which lists and edits them) and pi's check_back and schedule_job tools. Times are the
// user's local time.
import type { ThinkingLevel } from "./chat";

// When a job runs. `time` is "HH:MM"; `days` are 0 (Sunday) to 6. An hourly
// job runs every `every` hours counted from `from` (ms since epoch).
export type When =
  | { kind: "once"; at: number }
  | { kind: "hourly"; every: number; from: number }
  | { kind: "daily"; time: string }
  | { kind: "weekdays"; time: string }
  | { kind: "weekly"; days: number[]; time: string };

// What the background stores: jobs (the Scheduled view and schedule_job)
// and check-backs (check_back), each with an alarm for its next run.
export type Scheduled = Job | CheckBack;

// Runs in a new chat each time.
export type Job = {
  kind: "job";
  id: string;
  title: string;
  prompt: string;
  when: When;
  // The model and effort each run starts on; pi's default if unset.
  model?: { provider: string; id: string };
  thinkingLevel?: ThinkingLevel;
  paused: boolean;
  // The next run (ms since epoch).
  next?: number;
};

// The model's own follow-up: `note` comes back to its chat at `next`. One per
// chat.
export type CheckBack = { kind: "check_back"; id: string; chatId: number; note: string; next: number };

// What the panel and the tool send to make or change a job; the background
// fills in the rest.
export type JobDraft = Pick<Job, "title" | "prompt" | "when" | "model" | "thinkingLevel"> & { id?: string; paused?: boolean };

const HOUR = 3_600_000;

// The first run strictly after `after`, or undefined if there's none.
export function nextRun(when: When, after: number): number | undefined {
  switch (when.kind) {
    case "once":
      return when.at > after ? when.at : undefined;
    case "hourly": {
      const step = when.every * HOUR;
      if (when.from > after) return when.from;
      return when.from + (Math.floor((after - when.from) / step) + 1) * step;
    }
    case "daily":
    case "weekdays":
    case "weekly": {
      const [hours, minutes] = when.time.split(":").map(Number);
      const day = new Date(after);
      // A week ahead always holds a matching day.
      for (let i = 0; i <= 7; i++) {
        const run = new Date(day.getFullYear(), day.getMonth(), day.getDate() + i, hours, minutes);
        if (run.getTime() > after && runsOn(when, run.getDay())) return run.getTime();
      }
      return undefined;
    }
  }
}

function runsOn(when: When, weekday: number): boolean {
  if (when.kind === "weekdays") return weekday >= 1 && weekday <= 5;
  if (when.kind === "weekly") return when.days.includes(weekday);
  return true;
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAY_PLURALS = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];

function hhmm(ts: number): string {
  const date = new Date(ts);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

// The schedule in words, never as a rule.
export function describeWhen(when: When): string {
  switch (when.kind) {
    case "once":
      return `Once · ${new Date(when.at).toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${hhmm(when.at)}`;
    case "hourly":
      return when.every === 1 ? "Every hour" : `Every ${when.every} hours`;
    case "daily":
      return `Daily ${when.time}`;
    case "weekdays":
      return `Weekdays ${when.time}`;
    case "weekly": {
      const days = [...when.days].sort((a, b) => a - b);
      const names = days.length === 1 ? DAY_PLURALS[days[0]] : days.map((d) => DAY_NAMES[d]).join(", ");
      return `${names} ${when.time}`;
    }
  }
}

// What pi's tools ask the background. `check_back` and `cancel_check_back`
// (the check_back tool) act on the asking chat's one check-back; the rest
// (the schedule_job tool) on jobs, which always run in new chats.
export type ScheduleRequest =
  | { op: "check_back"; at: number; note: string }
  | { op: "cancel_check_back" }
  | { op: "create"; job: Pick<Job, "title" | "prompt" | "when"> }
  | { op: "list" }
  | { op: "cancel"; id: string };

// The message a run sends pi, so it knows who's asking: itself, following
// up in this chat, or a job running with no one watching.
export function runMessage(run: Scheduled): string {
  return run.kind === "job" ? `[Scheduled job: ${run.title}]\n\n${run.prompt}` : `[Check-back] ${run.note}`;
}

// A message `runMessage` wrote, read back (the chat shows it as a card);
// undefined for anything else.
export function parseRunMessage(text: string): { kind: "check_back"; note: string } | { kind: "job"; title: string; prompt: string } | undefined {
  if (text.startsWith("[Check-back] ")) return { kind: "check_back", note: text.slice("[Check-back] ".length) };
  const job = /^\[Scheduled job: ([^\n]*)\]\n\n([\s\S]*)$/.exec(text);
  return job ? { kind: "job", title: job[1], prompt: job[2] } : undefined;
}
