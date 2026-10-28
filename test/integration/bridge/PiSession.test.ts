// Runs PiSession against test/fixtures/fake-pi.ts, a stand-in for pi that
// speaks its RPC and writes real session files.
import { afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";

import { FAKE_PI } from "../../support/executables";
import { waitFor } from "../../support/wait";
import { PiSession } from "../../../src/bridge/PiSession";
import type { BridgeEvent } from "../../../src/bridge/protocol";

type Ready = Extract<BridgeEvent, { type: "ready" }>;

let session: PiSession;
let events: BridgeEvent[];

beforeAll(() => {
  // PiSession exits the bridge on a fatal error, and when pi exits.
  // Left in place after this file: sessions shut down here still report
  // pi's exit after the file ends.
  spyOn(process, "exit").mockImplementation((() => undefined) as never);
});

afterEach(() => {
  session?.shutdown();
  delete process.env.FAKE_PI_WRONG_SESSION;
});

function startSession(sessionFile?: string): PiSession {
  // Each session reports into its own list, so a finished one can't leak in.
  const own: BridgeEvent[] = (events = []);
  session = new PiSession((event) => own.push(event));
  session.start(sessionFile, FAKE_PI);
  return session;
}

const readies = () => events.filter((e): e is Ready => e.type === "ready");
// Waits for the nth `ready` (0-based).
const ready = (n: number) =>
  waitFor(() => {
    expect(readies().length).toBeGreaterThan(n);
    return readies()[n];
  });
const chunks = () => events.flatMap((e) => (e.type === "chunk" ? [e.chunk] : []));

// Starts pi, sends one prompt and waits for the reply; returns the saved session file.
async function chatOnce(text: string): Promise<string> {
  void startSession().prompt(text);
  await waitFor(() => expect(chunks().at(-1)?.type).toBe("run_end"));
  session.shutdown();
  return (await ready(0)).sessionFile!;
}

describe("PiSession", () => {
  test("starts pi on a new session and reports its models, commands and model state", async () => {
    startSession();
    const first = await ready(0);
    expect(first.history).toEqual([]);
    // A new session has a path, but pi hasn't saved it yet.
    expect(existsSync(first.sessionFile!)).toBe(false);
    expect(first.model).toMatchObject({ current: { provider: "fake", id: "m1" }, thinkingLevel: "medium" });
    expect(first.model.models.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(first.commands).toEqual([{ name: "skill:demo", description: "A demo skill" }]);
  });

  test("a prompt sent while pi starts waits for it, then streams back as one run", async () => {
    void startSession().prompt("hello");
    await waitFor(() => expect(chunks().at(-1)?.type).toBe("run_end"));
    // Nothing reaches pi before it's on the right session.
    expect(events[0].type).toBe("ready");
    expect(chunks()).toEqual([
      { type: "run_start", at: expect.any(Number) },
      { type: "text", content: "echo: hello" },
      { type: "usage", outputTokens: 3 },
      { type: "run_end", at: expect.any(Number), interrupted: false },
    ]);
  });

  test("resuming a saved session brings back its history", async () => {
    const file = await chatOnce("remember me");
    startSession(file);
    const resumed = await ready(0);
    expect(resumed.sessionFile).toBe(file);
    expect(resumed.history).toMatchObject([
      { role: "user", content: "remember me" },
      { role: "assistant", blocks: [{ type: "text", content: "echo: remember me" }] },
    ]);
  });

  test("a saved chat's history is sent before pi is up, then again with ready", async () => {
    const file = await chatOnce("remember me");
    startSession(file);
    await ready(0);
    const [first] = events;
    expect(first).toMatchObject({ type: "history", sessionFile: file, history: [{ role: "user", content: "remember me" }, { role: "assistant" }] });
  });

  test("a session file that was never saved starts a new session instead", async () => {
    startSession("/never/saved.jsonl");
    const fresh = await ready(0);
    expect(fresh.sessionFile).not.toBe("/never/saved.jsonl");
    expect(events.some((e) => e.type === "fatal")).toBe(false);
  });

  test("open moves the running pi to another chat, or to a new one", async () => {
    const saved = await chatOnce("first chat");
    startSession();
    await ready(0);

    session.open(saved);
    const switched = await ready(1);
    expect(switched.sessionFile).toBe(saved);
    expect(switched.history).toHaveLength(2);

    session.open(undefined);
    const fresh = await ready(2);
    expect(fresh.sessionFile).not.toBe(saved);
    expect(fresh.history).toEqual([]);
  });

  test("model changes report what pi settled on", async () => {
    startSession();
    await ready(0);
    await session.setModel("fake", "m2");
    expect(events.at(-1)).toMatchObject({ type: "model", model: { current: { provider: "fake", id: "m2" }, thinkingLevel: "off" } });
  });

  test("stops with a fatal error if pi isn't on the requested session", async () => {
    const file = await chatOnce("mine");
    process.env.FAKE_PI_WRONG_SESSION = "1";
    startSession(file);
    await waitFor(() => expect(events.find((e) => e.type === "fatal")).toMatchObject({ message: expect.stringContaining(`instead of ${file}`) }));
    expect(readies()).toEqual([]);
  });
});
