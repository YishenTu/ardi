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

// Asks the background what pi's schedule tool would, from `port`'s chat.
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
      { type: "prompt", text: "find new invoices", promptId: expect.any(String) },
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
    expect(bridge().sent.at(-1)).toMatchObject({ type: "prompt", text: "renew the domain" });
    expect((await schedules.listJobs()).map((j) => j.id)).toEqual([paused.id]);
  });
});

describe("pi's schedule tool", () => {
  test("creates a check-back in its own chat, on that chat's model, and can list and cancel it", async () => {
    const { meta } = await storedChat();
    const at = Date.now() + 10 * 60_000;
    const created = await tool({ op: "create", job: { title: "Deploy status", prompt: "is the deploy done?", when: { kind: "once", at } } });
    expect(created.error).toBeUndefined();
    const [job] = await schedules.listJobs();
    expect(job).toMatchObject({ title: "Deploy status", chatId: meta.id, model: MODEL.current, thinkingLevel: "high", next: at });

    const listed = await tool({ op: "list" });
    expect(listed.result).toMatchObject([{ id: job.id, title: "Deploy status" }]);
    await tool({ op: "cancel", id: job.id });
    expect(await schedules.listJobs()).toEqual([]);
    expect(chromeFake.alarms.size).toBe(0);
  });

  test("a repeating job from the tool runs in new chats, not this one", async () => {
    await storedChat();
    await tool({ op: "create", job: { title: "Inbox", prompt: "check inbox", when: { kind: "weekdays", time: "09:00" } } });
    expect((await schedules.listJobs())[0].chatId).toBeUndefined();
  });

  test("an invalid request is answered with an error, not dropped", async () => {
    await storedChat();
    expect((await tool({ op: "cancel", id: "nope" })).error).toBeString();
  });

  test("a check-back prompts its chat after the user moved on, and marks it unread", async () => {
    const { meta, port } = await storedChat();
    await tool({ op: "create", job: { title: "Deploy status", prompt: "is the deploy done?", when: { kind: "once", at: Date.now() + 60_000 } } }, port);
    idle(port);
    await pi.newSession();
    await waitFor(() => expect(port.disconnected).toBe(true));

    const [job] = await schedules.listJobs();
    await fire(job.id);
    expect(bridge()).not.toBe(port);
    expect(bridge().sent[0]).toEqual({ type: "start", sessionFile: meta.piSessionFile, piPath: undefined });
    expect(bridge().sent.at(-1)).toMatchObject({ type: "prompt", text: "is the deploy done?" });
    expect((await store.getSession(meta.id))?.unread).toBe(true);
  });

  test("deleting a chat or stopping it drops its check-backs", async () => {
    const first = await storedChat("one");
    await tool({ op: "create", job: { title: "A", prompt: "a", when: { kind: "once", at: Date.now() + 60_000 } } }, first.port);
    pi.abort();
    await waitFor(async () => expect(await schedules.listJobs()).toEqual([]));

    await tool({ op: "create", job: { title: "B", prompt: "b", when: { kind: "once", at: Date.now() + 60_000 } } }, first.port);
    await pi.deleteSession(first.meta.id);
    await waitFor(async () => expect(await schedules.listJobs()).toEqual([]));
  });
});
