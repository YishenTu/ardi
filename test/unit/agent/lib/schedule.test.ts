import { expect, test } from "bun:test";

import { registerSchedule } from "../../../../src/agent/lib/schedule";
import { SCHEDULE_DIALOG } from "../../../../src/bridge/protocol";

// The tools, with a ctx whose editor dialog answers as the bridge would.
function setup(answer: (request: any) => unknown) {
  const tools: Record<string, any> = {};
  registerSchedule({ registerTool: (t: any) => (tools[t.name] = t) } as any);
  const asked: any[] = [];
  const ctx = {
    ui: {
      async editor(title: string, prefill: string) {
        expect(title).toBe(SCHEDULE_DIALOG);
        const request = JSON.parse(prefill);
        asked.push(request);
        return JSON.stringify(answer(request));
      },
    },
  };
  const run = (name: string, params: Record<string, unknown>) => tools[name].execute("call", params, undefined, undefined, ctx);
  return { run, asked };
}

test("check_back in some minutes asks the background for this chat's check-back at that time", async () => {
  const { run, asked } = setup(() => ({ result: { at: "Nov 17 12:10" } }));
  const before = Date.now();
  const result = await run("check_back", { in_minutes: 10, note: "is the deploy done?" });
  expect(asked[0]).toMatchObject({ op: "check_back", note: "is the deploy done?" });
  expect(asked[0].at).toBeGreaterThanOrEqual(before + 600_000);
  expect(result.content[0].text).toContain("12:10");
  await run("check_back", { cancel: true });
  expect(asked[1]).toEqual({ op: "cancel_check_back" });
});

test("schedule_job carries its rule; weekly days by name", async () => {
  const { run, asked } = setup(() => ({ result: {} }));
  await run("schedule_job", { action: "create", title: "Digest", prompt: "summarize", repeat: "weekly", days: ["sun", "wed"], time: "18:00" });
  expect(asked[0]).toEqual({ op: "create", job: { title: "Digest", prompt: "summarize", when: { kind: "weekly", days: [0, 3], time: "18:00" } } });
  await run("schedule_job", { action: "create", title: "Desk", prompt: "check price", repeat: "hourly", every_hours: 6 });
  expect(asked[1].job.when).toMatchObject({ kind: "hourly", every: 6 });
  await run("schedule_job", { action: "create", title: "Renew", prompt: "renew", at: "2026-12-01T10:00" });
  expect(asked[2].job.when).toEqual({ kind: "once", at: new Date(2026, 11, 1, 10).getTime() });
});

test("a job without a time, or the background's refusal, fails the call", async () => {
  const { run } = setup(() => ({ error: "No scheduled job with id x" }));
  await expect(run("schedule_job", { action: "create", title: "A", prompt: "a", repeat: "daily" })).rejects.toThrow(/time/);
  await expect(run("check_back", { note: "x" })).rejects.toThrow(/in_minutes or at/);
  await expect(run("schedule_job", { action: "cancel", id: "x" })).rejects.toThrow("No scheduled job with id x");
});
