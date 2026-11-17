import { describe, expect, test } from "bun:test";

import { describeWhen, nextRun, parseRunMessage, runMessage } from "../../src/schedule";

// Local time, as the user sets it.
const at = (month: number, day: number, hour = 0, minute = 0) => new Date(2026, month - 1, day, hour, minute).getTime();
// Nov 17 2026 is a Tuesday.
const TUE_NOON = at(11, 17, 12);

describe("next run", () => {
  test("a one-time job runs at its time, and never once that has passed", () => {
    expect(nextRun({ kind: "once", at: at(12, 1, 10) }, TUE_NOON)).toBe(at(12, 1, 10));
    expect(nextRun({ kind: "once", at: at(11, 17, 9) }, TUE_NOON)).toBeUndefined();
  });

  test("a daily job runs later today, or tomorrow once today's time has passed", () => {
    expect(nextRun({ kind: "daily", time: "18:30" }, TUE_NOON)).toBe(at(11, 17, 18, 30));
    expect(nextRun({ kind: "daily", time: "09:00" }, TUE_NOON)).toBe(at(11, 18, 9));
    // Not again at the moment it just ran.
    expect(nextRun({ kind: "daily", time: "12:00" }, TUE_NOON)).toBe(at(11, 18, 12));
  });

  test("a weekday job skips the weekend", () => {
    const friday = at(11, 20, 12);
    expect(nextRun({ kind: "weekdays", time: "09:00" }, friday)).toBe(at(11, 23, 9));
  });

  test("a weekly job runs on its next chosen day", () => {
    // Sunday (0) and Wednesday (3).
    expect(nextRun({ kind: "weekly", days: [0, 3], time: "18:00" }, TUE_NOON)).toBe(at(11, 18, 18));
    expect(nextRun({ kind: "weekly", days: [2], time: "09:00" }, TUE_NOON)).toBe(at(11, 24, 9));
  });

  test("an hourly job keeps its rhythm from when it started", () => {
    const from = at(11, 17, 9, 15);
    expect(nextRun({ kind: "hourly", every: 2, from }, TUE_NOON)).toBe(at(11, 17, 13, 15));
    expect(nextRun({ kind: "hourly", every: 2, from }, at(11, 17, 8))).toBe(from);
  });
});

describe("described in words", () => {
  test("never as a rule, always as a person would say it", () => {
    expect(describeWhen({ kind: "daily", time: "09:00" })).toBe("Daily 09:00");
    expect(describeWhen({ kind: "weekdays", time: "09:00" })).toBe("Weekdays 09:00");
    expect(describeWhen({ kind: "weekly", days: [0], time: "18:00" })).toBe("Sundays 18:00");
    expect(describeWhen({ kind: "weekly", days: [3, 1], time: "08:00" })).toBe("Mon, Wed 08:00");
    expect(describeWhen({ kind: "hourly", every: 1, from: 0 })).toBe("Every hour");
    expect(describeWhen({ kind: "hourly", every: 6, from: 0 })).toBe("Every 6 hours");
    expect(describeWhen({ kind: "once", at: at(12, 1, 10) })).toMatch(/^Once · .*10:00$/);
  });
});

describe("a run's message", () => {
  const job = { kind: "job" as const, id: "j", title: "Invoice check", prompt: "find new invoices\n\nand totals", when: { kind: "daily" as const, time: "09:00" }, paused: false };

  test("reads back as the run it came from; anything else is the user's own", () => {
    expect(parseRunMessage(runMessage(job))).toEqual({ kind: "job", title: "Invoice check", prompt: "find new invoices\n\nand totals" });
    expect(parseRunMessage(runMessage({ kind: "check_back", id: "c", chatId: 1, note: "is it done?", next: 1 }))).toEqual({ kind: "check_back", note: "is it done?" });
    expect(parseRunMessage("what's [Check-back] for?")).toBeUndefined();
  });
});
