import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { SCHEDULE_DIALOG } from "../../bridge/protocol";
import type { ScheduleRequest, When } from "../../schedule";
import { text } from "./page";

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

const parameters = Type.Object({
  action: Type.Union([Type.Literal("create"), Type.Literal("list"), Type.Literal("cancel")]),
  id: Type.Optional(Type.String({ description: "Job id, for cancel" })),
  title: Type.Optional(Type.String({ description: "Short name the user sees in the job list and on each run's chat" })),
  prompt: Type.Optional(Type.String({ description: "What to do when it runs. A repeating job's run starts in a new chat that sees only this, so make it self-contained." })),
  in_minutes: Type.Optional(Type.Number({ minimum: 1, description: "One-time: run this many minutes from now" })),
  at: Type.Optional(Type.String({ description: "One-time: local date and time, YYYY-MM-DDTHH:MM" })),
  repeat: Type.Optional(Type.Union([Type.Literal("hourly"), Type.Literal("daily"), Type.Literal("weekdays"), Type.Literal("weekly")])),
  time: Type.Optional(Type.String({ description: "Local time HH:MM, for daily, weekdays and weekly" })),
  days: Type.Optional(Type.Array(Type.Union(DAYS.map((d) => Type.Literal(d))), { description: "For weekly" })),
  every_hours: Type.Optional(Type.Number({ minimum: 1, description: "For hourly; default 1" })),
});
type Params = Static<typeof parameters>;

function whenOf(p: Params): When {
  if (p.repeat === "hourly") return { kind: "hourly", every: p.every_hours ?? 1, from: Date.now() };
  if (p.repeat) {
    if (!p.time || !TIME.test(p.time)) throw new Error(`A ${p.repeat} job needs a time as HH:MM`);
    if (p.repeat !== "weekly") return { kind: p.repeat, time: p.time };
    if (!p.days?.length) throw new Error("A weekly job needs its days");
    return { kind: "weekly", days: p.days.map((d) => DAYS.indexOf(d)), time: p.time };
  }
  if (p.in_minutes) return { kind: "once", at: Date.now() + p.in_minutes * 60_000 };
  const at = p.at ? new Date(p.at).getTime() : NaN;
  if (Number.isNaN(at)) throw new Error("Give in_minutes or at for a one-time job, or repeat for a repeating one");
  return { kind: "once", at };
}

function requestOf(p: Params): ScheduleRequest {
  if (p.action === "list") return { op: "list" };
  if (p.action === "cancel") {
    if (!p.id) throw new Error("cancel needs the job's id; list shows it");
    return { op: "cancel", id: p.id };
  }
  if (!p.title || !p.prompt) throw new Error("create needs a title and a prompt");
  return { op: "create", job: { title: p.title, prompt: p.prompt, when: whenOf(p) } };
}

// Asks Ardi's background through the bridge (see SCHEDULE_DIALOG).
async function ask(ctx: ExtensionContext, request: ScheduleRequest): Promise<unknown> {
  const answer = await ctx.ui.editor(SCHEDULE_DIALOG, JSON.stringify(request));
  if (answer === undefined) throw new Error("Scheduling isn't available here");
  const reply = JSON.parse(answer) as { result?: unknown; error?: string };
  if (reply.error) throw new Error(reply.error);
  return reply.result;
}

export function registerSchedule(pi: ExtensionAPI) {
  pi.registerTool({
    name: "schedule",
    label: "Schedule",
    description: [
      "Run a prompt later, once or on a schedule.",
      "One-time (in_minutes or at) runs in this chat: use it to check back on something slow (a deploy, an email, a price, a download) instead of waiting, or when the user asks you to follow up later. When it runs, you get the prompt as a new message here.",
      "Repeating (repeat) runs in a new chat each time, on this chat's model: use it when the user asks for an automation job.",
      "list shows jobs with their ids; cancel removes one. Jobs run only while the browser is open; runs missed while it was closed are skipped. The user can also see and edit jobs in Ardi's Scheduled view.",
    ].join(" "),
    parameters,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const result = await ask(ctx, requestOf(params));
      return text(JSON.stringify(result, null, 2), result);
    },
  });
}
