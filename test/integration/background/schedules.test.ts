// Scheduled jobs and check-backs: stored and armed by the background, run by
// its pi session when their alarm fires, with or without a panel open.
import "../../support/indexeddb";

import { beforeEach, describe, expect, test } from "bun:test";

import { chromeFake, FakePort } from "../../support/chrome";
import { waitFor } from "../../support/wait";
import type { BridgeEvent } from "../../../src/bridge/protocol";
import type { PanelUpdate } from "../../../src/panel-protocol";
import * as schedules from "../../../src/background/schedules";
import * as store from "../../../src/background/store";
import { setTarget } from "../../../src/background/target";

type Background = typeof import("../../../src/background/pi-session");

let pi: Background;
let copies = 0;

beforeEach(async () => {
  setTarget({ nativeHost: "com.ardi.test" });
  for (const chat of await store.listSessions()) await store.deleteSession(chat.id);
  pi = (await import(`../../../src/background/pi-session.ts?schedules=${copies++}`)) as Background;
  await schedules.noteBrowserStart();
});

const bridge = () => chromeFake.nativePorts.at(-1)!;
const fromBridge = (event: BridgeEvent, to = bridge()) => to.receive(event);
const received = (port: FakePort) => port.sent.filter((r: { type: string }) => !r.type.endsWith("_reply")).length;
const idle = (to = bridge()) => fromBridge({ type: "busy", busy: false, requests: received(to) }, to);
const MODEL = { models: [], current: { provider: "fake", id: "m2" }, thinkingLevel: "high" as const };

// Fires a job's alarm the way Chrome would, for the run at `scheduledTime`.
async function fire(id: string, scheduledTime?: number) {
  const alarm = chromeFake.alarms.get(`job:${id}`)!;
  const job = await schedules.due({ ...alarm, scheduledTime: scheduledTime ?? alarm.scheduledTime });
  if (job) await pi.runJob(job);
  return job;
}

// A stored chat with pi done with its first message, and its bridge.
async function storedChat(text = "watch the deploy") {
  await pi.prompt(text);
  const port = bridge();
  fromBridge({ type: "ready", sessionFile: `/sessions/${text}.jsonl`, history: [], model: MODEL, commands: [] });
  await waitFor(async () => expect((await store.listSessions())[0]?.piSessionFile).toBe(`/sessions/${text}.jsonl`));
  return { meta: (await store.listSessions())[0], port };
}

// Asks the background what pi's check_back or schedule_job tool would, from `port`'s chat.
async function tool(request: unknown, port = bridge()) {
  const id = crypto.randomUUID();
  fromBridge({ type: "schedule_request", id, request } as BridgeEvent, port);
  return waitFor(() => {
    const reply = port.sent.find((r: { type: string; id?: string }) => r.type === "schedule_reply" && r.id === id);
    expect(reply).toBeDefined();
    return reply as { result?: any; error?: string };
  });
}

describe("scheduled jobs", () => {
  test("a job that comes due with no panel open runs in a new chat named after it, on its model and effort, marked unread", async () => {
    const job = await schedules.saveJob({
      title: "Invoice check", prompt: "find new invoices", when: { kind: "daily", time: "09:00" },
      model: { provider: "fake", id: "m2" }, thinkingLevel: "high",
    });
    expect(chromeFake.alarms.get(`job:${job.id}`)?.scheduledTime).toBe(job.next);

    await fire(job.id);
    expect(bridge().sent).toEqual([
      { type: "start", sessionFile: undefined, piPath: undefined },
      { type: "set_model", provider: "fake", modelId: "m2" },
      { type: "set_thinking_level", level: "high" },
      { type: "prompt", text: "[Scheduled job: Invoice check]\n\nfind new invoices", promptId: expect.any(String) },
    ]);
    const [chat] = await store.listSessions();
    expect(chat).toMatchObject({ title: "Invoice check", unread: true });
    // The job waits for its next time.
    const [after] = await schedules.listJobs();
    expect(after.next!).toBeGreaterThan(job.next!);
    expect(chromeFake.alarms.get(`job:${job.id}`)?.scheduledTime).toBe(after.next);
  });

  test("a panel that opens later sees the run's chat, and opening it clears unread", async () => {
    const job = await schedules.saveJob({ title: "Digest", prompt: "summarize", when: { kind: "hourly", every: 1, from: Date.now() + 1000 } });
    await fire(job.id);
    const panel = new FakePort("panel");
    await pi.attachPanel(panel.port);
    const sessions = (panel.sent as PanelUpdate[]).findLast((u) => u.kind === "sessions") as Extract<PanelUpdate, { kind: "sessions" }>;
    expect(sessions.sessions[0]).toMatchObject({ title: "Digest", unread: true });
    expect(sessions.currentId).not.toBe(sessions.sessions[0].id);

    await pi.switchSession(sessions.sessions[0].id);
    expect((await store.listSessions())[0].unread).toBeFalsy();
  });

  test("a run missed while the browser was quit is skipped, and the job waits for its next time", async () => {
    const job = await schedules.saveJob({ title: "Digest", prompt: "summarize", when: { kind: "daily", time: "09:00" } });
    // Due before this browser session started.
    expect(await fire(job.id, Date.now() - 3_600_000)).toBeUndefined();
    expect(chromeFake.nativePorts).toHaveLength(0);
    expect((await schedules.listJobs())[0].next!).toBeGreaterThan(Date.now());
  });

  test("a one-time job runs once and is gone; a paused job doesn't run", async () => {
    const once = await schedules.saveJob({ title: "Renew", prompt: "renew the domain", when: { kind: "once", at: Date.now() + 60_000 } });
    const paused = await schedules.saveJob({ title: "Desk", prompt: "check price", when: { kind: "daily", time: "09:00" }, paused: true });
    expect(chromeFake.alarms.has(`job:${paused.id}`)).toBe(false);
    await fire(once.id);
    expect(bridge().sent.at(-1)).toMatchObject({ type: "prompt", text: "[Scheduled job: Renew]\n\nrenew the domain" });
    expect((await schedules.listJobs()).map((j) => j.id)).toEqual([paused.id]);
  });
});

describe("pi's check_back tool", () => {
  const checkBack = (note: string, port?: FakePort, at = Date.now() + 10 * 60_000) => tool({ op: "check_back", at, note }, port);

  test("sets one check-back for its own chat; a new one replaces it, and cancel clears it", async () => {
    const { meta } = await storedChat();
    const at = Date.now() + 10 * 60_000;
    expect((await checkBack("is the deploy done?", undefined, at)).error).toBeUndefined();
    expect(await schedules.listJobs()).toMatchObject([{ chatId: meta.id, prompt: "is the deploy done?", when: { kind: "once", at }, next: at }]);

    await checkBack("check the deploy again");
    expect(await schedules.listJobs()).toMatchObject([{ chatId: meta.id, prompt: "check the deploy again" }]);
    await tool({ op: "cancel_check_back" });
    expect(await schedules.listJobs()).toEqual([]);
    expect(chromeFake.alarms.size).toBe(0);
  });

  test("a check-back prompts its chat after the user moved on, marked as one, and marks the chat unread", async () => {
    const { meta, port } = await storedChat();
    await checkBack("is the deploy done?", port, Date.now() + 60_000);
    idle(port);
    await pi.newSession();
    await waitFor(() => expect(port.disconnected).toBe(true));

    const [job] = await schedules.listJobs();
    await fire(job.id);
    expect(bridge()).not.toBe(port);
    expect(bridge().sent[0]).toEqual({ type: "start", sessionFile: meta.piSessionFile, piPath: undefined });
    expect(bridge().sent.at(-1)).toMatchObject({ type: "prompt", text: "[Check-back] is the deploy done?" });
    expect((await store.getSession(meta.id))?.unread).toBe(true);
  });

  test("Stop leaves the model's check-back; deleting the chat drops it", async () => {
    const first = await storedChat("one");
    await checkBack("a", first.port);
    pi.abort();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await schedules.listJobs()).toHaveLength(1);

    await pi.deleteSession(first.meta.id);
    await waitFor(async () => expect(await schedules.listJobs()).toEqual([]));
  });
});

describe("pi's schedule_job tool", () => {
  test("creates jobs that run in new chats on this chat's model, even one-time ones, and can list and cancel them", async () => {
    await storedChat();
    await tool({ op: "create", job: { title: "Inbox", prompt: "check inbox", when: { kind: "weekdays", time: "09:00" } } });
    await tool({ op: "create", job: { title: "Renew", prompt: "renew the domain", when: { kind: "once", at: Date.now() + 60_000 } } });
    const jobs = await schedules.listJobs();
    expect(jobs).toMatchObject([{ title: "Inbox", model: MODEL.current, thinkingLevel: "high" }, { title: "Renew" }]);
    expect(jobs.every((j) => j.chatId === undefined)).toBe(true);

    expect((await tool({ op: "list" })).result).toMatchObject([{ id: jobs[0].id, title: "Inbox" }, { title: "Renew" }]);
    await tool({ op: "cancel", id: jobs[0].id });
    expect((await schedules.listJobs()).map((j) => j.title)).toEqual(["Renew"]);
  });

  test("the Scheduled view lists only jobs, not check-backs", async () => {
    await storedChat();
    await tool({ op: "check_back", at: Date.now() + 60_000, note: "later" });
    await tool({ op: "create", job: { title: "Inbox", prompt: "check inbox", when: { kind: "daily", time: "09:00" } } });
    expect((await schedules.scheduledJobs()).map((j) => j.title)).toEqual(["Inbox"]);
  });

  test("lists only jobs, not check-backs", async () => {
    await storedChat();
    await tool({ op: "check_back", at: Date.now() + 60_000, note: "later" });
    expect((await tool({ op: "list" })).result).toEqual([]);
  });

  test("an invalid request is answered with an error, not dropped", async () => {
    await storedChat();
    expect((await tool({ op: "cancel", id: "nope" })).error).toBeString();
  });
});
