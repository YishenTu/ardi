import { expect, test } from "bun:test";

import { registerSchedule } from "../../../../src/agent/lib/schedule";
import { SCHEDULE_DIALOG } from "../../../../src/bridge/protocol";

// The tool, with a ctx whose editor dialog answers as the bridge would.
function setup(answer: (request: any) => unknown) {
  let tool: any;
  registerSchedule({ registerTool: (t: any) => (tool = t) } as any);
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
  const run = (params: Record<string, unknown>) => tool.execute("call", params, undefined, undefined, ctx);
  return { run, asked };
}

test("a check-back in some minutes asks the background for a one-time job at that time", async () => {
  const { run, asked } = setup(() => ({ result: { id: "j1", when: "Once · Nov 17 12:10" } }));
  const before = Date.now();
  const result = await run({ action: "create", title: "Deploy", prompt: "is it done?", in_minutes: 10 });
  expect(asked[0]).toMatchObject({ op: "create", job: { title: "Deploy", prompt: "is it done?", when: { kind: "once" } } });
  expect(asked[0].job.when.at).toBeGreaterThanOrEqual(before + 600_000);
  expect(result.content[0].text).toContain("j1");
});

test("repeating jobs carry their rule; weekly days by name", async () => {
  const { run, asked } = setup(() => ({ result: {} }));
  await run({ action: "create", title: "Digest", prompt: "summarize", repeat: "weekly", days: ["sun", "wed"], time: "18:00" });
  expect(asked[0].job.when).toEqual({ kind: "weekly", days: [0, 3], time: "18:00" });
  await run({ action: "create", title: "Desk", prompt: "check price", repeat: "hourly", every_hours: 6 });
  expect(asked[1].job.when).toMatchObject({ kind: "hourly", every: 6 });
});

test("a job without a time, or the background's refusal, fails the call", async () => {
  const { run } = setup(() => ({ error: "No scheduled job with id x" }));
  await expect(run({ action: "create", title: "A", prompt: "a", repeat: "daily" })).rejects.toThrow(/time/);
  await expect(run({ action: "cancel", id: "x" })).rejects.toThrow("No scheduled job with id x");
});
