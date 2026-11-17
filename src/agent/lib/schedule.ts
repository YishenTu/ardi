import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { SCHEDULE_DIALOG } from "../../bridge/protocol";
import type { ScheduleRequest, When } from "../../schedule";
import { text } from "./page";

// Two tools on one mechanism: check_back follows up in this chat; schedule_job
// sets up automation that runs in new chats. Both ask Ardi's background
// through the bridge (see SCHEDULE_DIALOG).

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

const once = {
  in_minutes: Type.Optional(Type.Number({ minimum: 1, description: "Minutes from now" })),
  at: Type.Optional(Type.String({ description: "Local date and time, YYYY-MM-DDTHH:MM" })),
};

// A one-time run's time, from in_minutes or at.
function onceAt(p: { in_minutes?: number; at?: string }): number {
  if (p.in_minutes) return Date.now() + p.in_minutes * 60_000;
  const at = p.at ? new Date(p.at).getTime() : NaN;
  if (Number.isNaN(at)) throw new Error("Give in_minutes or at");
  return at;
}

const checkBackParameters = Type.Object({
  ...once,
  note: Type.Optional(Type.String({ description: "What to check when it fires: you get it back as a message in this chat" })),
  cancel: Type.Optional(Type.Boolean({ description: "Clear this chat's check-back instead, once there's nothing left to check" })),
});

const jobParameters = Type.Object({
  action: Type.Union([Type.Literal("create"), Type.Literal("list"), Type.Literal("cancel")]),
  id: Type.Optional(Type.String({ description: "Job id, for cancel; list shows it" })),
  title: Type.Optional(Type.String({ description: "Short name the user sees in the job list and on each run's chat" })),
  prompt: Type.Optional(Type.String({ description: "The task. Each run starts in a new chat that sees only this, with no one there to answer questions, so make it self-contained." })),
  ...once,
  repeat: Type.Optional(Type.Union([Type.Literal("hourly"), Type.Literal("daily"), Type.Literal("weekdays"), Type.Literal("weekly")])),
  time: Type.Optional(Type.String({ description: "Local time HH:MM, for daily, weekdays and weekly" })),
  days: Type.Optional(Type.Array(Type.Union(DAYS.map((d) => Type.Literal(d))), { description: "For weekly" })),
  every_hours: Type.Optional(Type.Number({ minimum: 1, description: "For hourly; default 1" })),
});
type JobParams = Static<typeof jobParameters>;

function whenOf(p: JobParams): When {
  if (p.repeat === "hourly") return { kind: "hourly", every: p.every_hours ?? 1, from: Date.now() };
  if (!p.repeat) return { kind: "once", at: onceAt(p) };
  if (!p.time || !TIME.test(p.time)) throw new Error(`A ${p.repeat} job needs a time as HH:MM`);
  if (p.repeat !== "weekly") return { kind: p.repeat, time: p.time };
  if (!p.days?.length) throw new Error("A weekly job needs its days");
  return { kind: "weekly", days: p.days.map((d) => DAYS.indexOf(d)), time: p.time };
}

function jobRequest(p: JobParams): ScheduleRequest {
  if (p.action === "list") return { op: "list" };
  if (p.action === "cancel") {
    if (!p.id) throw new Error("cancel needs the job's id; list shows it");
    return { op: "cancel", id: p.id };
  }
  if (!p.title || !p.prompt) throw new Error("create needs a title and a prompt");
  return { op: "create", job: { title: p.title, prompt: p.prompt, when: whenOf(p) } };
}

async function ask(ctx: ExtensionContext, request: ScheduleRequest): Promise<unknown> {
  const answer = await ctx.ui.editor(SCHEDULE_DIALOG, JSON.stringify(request));
  if (answer === undefined) throw new Error("Scheduling isn't available here");
  const reply = JSON.parse(answer) as { result?: unknown; error?: string };
  if (reply.error) throw new Error(reply.error);
  return reply.result;
}

const reply = (result: unknown) => text(JSON.stringify(result, null, 2), result);

export function registerSchedule(pi: ExtensionAPI) {
  pi.registerTool({
    name: "check_back",
    label: "Check back",
    description: [
      "Come back to this chat later: your note returns here as a [Check-back] message.",
      "For anything slower than about a minute (deploy, build, download, reply), never sleep or poll: set a check-back, tell the user when you'll look again, and end your turn.",
      "Also use it to follow up later when asked.",
      "One per chat; a new one replaces it. If it's still not done, set another further out; stop after a few tries. Cancel it if it finishes early.",
      "For scheduled tasks, use schedule_job.",
    ].join(" "),
    parameters: checkBackParameters,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (params.cancel) return reply(await ask(ctx, { op: "cancel_check_back" }));
      if (!params.note) throw new Error("check_back needs a note");
      return reply(await ask(ctx, { op: "check_back", at: onceAt(params), note: params.note }));
    },
  });

  pi.registerTool({
    name: "schedule_job",
    label: "Schedule job",
    description: [
      "Set up an automation job the user asked for: a task that runs at a time (in_minutes or at) or on a schedule (repeat).",
      "Each run starts in a new chat on this chat's model and effort, without this conversation, and begins with [Scheduled job: title].",
      "list shows jobs with their ids; cancel removes one. Jobs run only while the browser is open; runs missed while it was closed are skipped.",
      "The user can also see and edit jobs in Ardi's Scheduled view. To follow up in this chat yourself, use check_back.",
    ].join(" "),
    parameters: jobParameters,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      return reply(await ask(ctx, jobRequest(params)));
    },
  });
}
