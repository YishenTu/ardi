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

afterEach(async () => {
  await session?.shutdown();
  delete process.env.FAKE_PI_WRONG_SESSION;
});

function startSession(sessionFile?: string): PiSession {
  // Each session reports into its own list, so a finished one can't leak in.
  const own: BridgeEvent[] = (events = []);
  session = new PiSession({ extension: "/agent/extension", tools: [] }, (event) => own.push(event));
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
// Each busy report: pi working or input waiting (true), or nothing left (false).
const busy = () => events.flatMap((e) => (e.type === "busy" ? [e.busy] : []));
// Everything else the session sent, in order.
const reported = () => events.filter((e) => e.type !== "busy");

// Starts pi, sends one prompt and waits for the reply; returns the saved session file.
async function chatOnce(text: string): Promise<string> {
  void startSession().prompt(text);
  await waitFor(() => expect(chunks().at(-1)?.type).toBe("run_end"));
  await session.shutdown();
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
    expect(reported()[0].type).toBe("ready");
    expect(chunks()).toEqual([
      { type: "run_start", at: expect.any(Number) },
      { type: "user", text: "hello", at: expect.any(Number) },
      { type: "text", content: "echo: hello" },
      { type: "usage", outputTokens: 3 },
      { type: "run_end", at: expect.any(Number), interrupted: false },
    ]);
  });

  test("images sent with a prompt reach pi and come back in the saved history", async () => {
    const images = [{ data: "aGk=", mimeType: "image/png" }];
    void startSession().prompt("what's this?", { images });
    await waitFor(() => expect(chunks().at(-1)?.type).toBe("run_end"));
    await session.shutdown();
    startSession((await ready(0)).sessionFile);
    expect((await ready(0)).history[0]).toMatchObject({ role: "user", content: "what's this?", images });
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
    const [first] = reported();
    expect(first).toMatchObject({ type: "history", sessionFile: file, history: [{ role: "user", content: "remember me" }, { role: "assistant" }] });
  });

  test("a session file that was never saved starts a new session instead", async () => {
    startSession("/never/saved.jsonl");
    const fresh = await ready(0);
    expect(fresh.sessionFile).not.toBe("/never/saved.jsonl");
    expect(events.some((e) => e.type === "fatal")).toBe(false);
  });

  test("reports pi busy from the first message until its run settles, without a gap", async () => {
    void startSession().prompt("hi");
    await waitFor(() => expect(chunks().at(-1)?.type).toBe("run_end"));
    await waitFor(() => expect(busy()).toEqual([true, false]));
    // Idle comes after the run's end, so the extension sees the end before stopping it.
    const end = events.findIndex((e) => e.type === "chunk" && e.chunk.type === "run_end");
    expect(events.findLastIndex((e) => e.type === "busy")).toBeGreaterThan(end);
  });

  test("a compaction counts as busy until pi answers it", async () => {
    startSession();
    await ready(0);
    await waitFor(() => expect(busy().at(-1)).toBe(false));
    const before = busy().length;
    await session.compact();
    await waitFor(() => expect(busy().slice(before)).toEqual([true, false]));
  });

  test("model changes report what pi settled on", async () => {
    startSession();
    await ready(0);
    await session.setModel("fake", "m2");
    expect(reported().at(-1)).toMatchObject({ type: "model", model: { current: { provider: "fake", id: "m2" }, thinkingLevel: "off" } });
  });

  test("stops with a fatal error if pi isn't on the requested session", async () => {
    const file = await chatOnce("mine");
    process.env.FAKE_PI_WRONG_SESSION = "1";
    startSession(file);
    await waitFor(() => expect(events.find((e) => e.type === "fatal")).toMatchObject({ message: expect.stringContaining(`instead of ${file}`) }));
    expect(readies()).toEqual([]);
  });
});

test("browser permission results distinguish started, rejected and handled prompts", async () => {
  startSession();
  await ready(0);
  await session.prompt("reject:busy", { promptId: "rejected" });
  expect(events).toContainEqual({ type: "prompt_result", promptId: "rejected", started: false });
  expect(chunks()).toContainEqual({ type: "notice", content: expect.stringContaining("already streaming"), level: "error" });
  await session.prompt("handled:command", { promptId: "handled" });
  expect(events).toContainEqual({ type: "prompt_result", promptId: "handled", started: false });
  await session.prompt("accepted", { promptId: "accepted" });
  expect(events).toContainEqual({ type: "prompt_result", promptId: "accepted", started: true });
});

describe("messages sent while pi works", () => {
  const queues = () => events.flatMap((e) => (e.type === "queue" ? [e.queue] : []));
  // User messages after the one that started the held run.
  const users = () => chunks().flatMap((c) => (c.type === "user" && !c.text.startsWith("hold") ? [c] : []));
  const delivered = () => users().map((c) => c.text);
  const deliveredImages = () => users().map((c) => c.images?.[0]?.data);
  const A = [{ data: "QQ==", mimeType: "image/png" }];
  const B = [{ data: "Qg==", mimeType: "image/png" }];

  async function holding() {
    void startSession().prompt("hold");
    await waitFor(() => expect(chunks()).toContainEqual({ type: "text", content: "echo: hold" }));
  }

  test("wait in the queue until steered, then show in the chat when pi takes them", async () => {
    await holding();
    const images = [{ data: "aGk=", mimeType: "image/png" }];
    await session.prompt("check promotions", { images });
    expect(queues().at(-1)).toEqual([{ text: "check promotions", steer: false }]);
    expect(delivered()).toEqual([]);

    await session.queueAction({ action: "steer", index: 0, text: "check promotions" });
    await waitFor(() => expect(chunks().at(-1)?.type).toBe("run_end"));
    expect(users()).toEqual([{ type: "user", text: "check promotions", images, at: expect.any(Number) }]);
    expect(chunks()).toContainEqual({ type: "text", content: "echo: check promotions" });
    expect(queues().at(-1)).toEqual([]);
  });

  test("a steered message goes ahead of follow-ups", async () => {
    await holding();
    await session.prompt("later");
    await session.prompt("now", { steer: true });
    await waitFor(() => expect(chunks().at(-1)?.type).toBe("run_end"));
    expect(delivered()).toEqual(["now", "later"]);
  });

  test("a removed message never reaches pi", async () => {
    await holding();
    await session.prompt("drop me");
    await session.prompt("keep me");
    await session.queueAction({ action: "remove", index: 0, text: "drop me" });
    expect(queues().at(-1)).toEqual([{ text: "keep me", steer: false }]);
    await session.prompt("go", { steer: true });
    await waitFor(() => expect(chunks().at(-1)?.type).toBe("run_end"));
    expect(delivered()).toEqual(["go", "keep me"]);
  });

  test("editing takes a message out of the queue and back to the message box", async () => {
    await holding();
    await session.prompt("fix me", { images: A });
    await session.prompt("keep me");
    await session.queueAction({ action: "edit", index: 0, text: "fix me" });
    expect(events).toContainEqual({ type: "restore", text: "fix me", images: A });
    expect(queues().at(-1)).toEqual([{ text: "keep me", steer: false }]);
    await session.prompt("go", { steer: true });
    await waitFor(() => expect(chunks().at(-1)?.type).toBe("run_end"));
    expect(delivered()).toEqual(["go", "keep me"]);
  });

  test("a message sent just before a stop goes back to the box instead of to pi", async () => {
    await holding();
    const sent = session.prompt("too late");
    await session.abort();
    await sent;
    await waitFor(() => expect(chunks().at(-1)).toMatchObject({ type: "run_end", interrupted: true }));
    expect(events).toContainEqual({ type: "restore", text: "too late" });
    expect(delivered()).toEqual([]);
  });

  test("stopping hands the queued messages back instead of sending them", async () => {
    await holding();
    await session.prompt("first");
    await session.prompt("second");
    await session.abort();
    await waitFor(() => expect(chunks().at(-1)).toMatchObject({ type: "run_end", interrupted: true }));
    expect(events).toContainEqual({ type: "restore", text: "first\n\nsecond" });
    expect(delivered()).toEqual([]);
    expect(queues().at(-1)).toEqual([]);
  });

  test("a message pi takes before it answers still shows in the chat, once", async () => {
    await holding();
    await session.prompt("eager: now", { steer: true });
    await waitFor(() => expect(chunks()).toContainEqual({ type: "text", content: "echo: eager: now" }));
    expect(delivered()).toEqual(["eager: now"]);
    expect(queues().at(-1)).toEqual([]);
  });

  test("queue edits made at once each act on the message they name", async () => {
    await holding();
    for (const text of ["a", "b", "c"]) await session.prompt(text);
    await Promise.all([session.queueAction({ action: "remove", index: 0, text: "a" }), session.queueAction({ action: "remove", index: 1, text: "b" })]);
    expect(queues().at(-1)).toEqual([{ text: "c", steer: false }]);
    await session.prompt("go", { steer: true });
    await waitFor(() => expect(chunks().at(-1)?.type).toBe("run_end"));
    expect(delivered()).toEqual(["go", "c"]);
  });

  test("an edit names its message: one pi already took is left alone, a moved one is still found", async () => {
    await holding();
    await session.prompt("a");
    await session.prompt("b");
    await session.queueAction({ action: "remove", index: 0, text: "gone" });
    expect(queues().at(-1)).toEqual([{ text: "a", steer: false }, { text: "b", steer: false }]);
    await session.queueAction({ action: "remove", index: 0, text: "b" });
    expect(queues().at(-1)).toEqual([{ text: "a", steer: false }]);
  });

  test("a message pi takes while a stop clears the queue isn't also handed back", async () => {
    await holding();
    await session.prompt("slip: mine");
    await session.prompt("back");
    await session.abort();
    await waitFor(() => expect(chunks().at(-1)).toMatchObject({ type: "run_end" }));
    expect(delivered()).toEqual(["slip: mine"]);
    expect(events.filter((e) => e.type === "restore")).toEqual([{ type: "restore", text: "back" }]);
  });

  test("messages put back after the run ended start a new run instead of waiting forever", async () => {
    void startSession().prompt("hold-till-clear");
    await waitFor(() => expect(chunks()).toContainEqual({ type: "text", content: "echo: hold-till-clear" }));
    await session.prompt("a", { images: A });
    await session.prompt("b");
    // Clearing pi's queue ends the held run before the messages go back.
    await session.queueAction({ action: "steer", index: 1, text: "b" });
    await waitFor(() => expect(delivered()).toEqual(["b", "a"]));
    await waitFor(() => expect(chunks().at(-1)?.type).toBe("run_end"));
    expect(deliveredImages()).toEqual([undefined, "QQ=="]);
    // Never idle while the messages were on their way back to pi.
    await waitFor(() => expect(busy()).toEqual([true, false]));
  });

  test("equal texts keep their own images when sent again", async () => {
    await holding();
    await session.prompt("look", { images: A });
    await session.prompt("look", { images: B });
    await session.queueAction({ action: "steer", index: 1, text: "look" });
    // The steered one first, each with its own image.
    await waitFor(() => expect(deliveredImages()).toEqual(["Qg==", "QQ=="]));
  });

  test("equal texts in steering and follow-ups keep their own images when sent again", async () => {
    void startSession().prompt("hold-till-clear");
    await waitFor(() => expect(chunks()).toContainEqual({ type: "text", content: "echo: hold-till-clear" }));
    await session.prompt("x", { images: A });
    await session.prompt("x", { images: B, steer: true });
    await session.prompt("z");
    // Clearing ends the held run; the rest goes back, steering first.
    await session.queueAction({ action: "remove", index: 2, text: "z" });
    await waitFor(() => expect(deliveredImages()).toEqual(["Qg==", "QQ=="]));
  });

  test("an image-only message pi takes shows in the chat and leaves the queue", async () => {
    await holding();
    await session.prompt("", { images: A, steer: true });
    await waitFor(() => expect(chunks().at(-1)?.type).toBe("run_end"));
    expect(users()).toEqual([{ type: "user", text: "", images: A, at: expect.any(Number) }]);
    await waitFor(() => expect(queues().at(-1)).toEqual([]));
  });

  test("a skill command keeps its images when sent again", async () => {
    await holding();
    await session.prompt("/skill:demo now", { images: A });
    const [queued] = queues().at(-1)!;
    expect(queued.text).toBe("expanded demo: now");
    await session.queueAction({ action: "steer", index: 0, text: queued.text });
    await waitFor(() => expect(chunks().at(-1)?.type).toBe("run_end"));
    expect(deliveredImages()).toEqual(["QQ=="]);
  });
});

describe("what the chat shows", () => {
  const users = () => chunks().filter((c) => c.type === "user");

  test("each message shows as pi has it, before pi's reply", async () => {
    void startSession().prompt("hello");
    await waitFor(() => expect(chunks().at(-1)?.type).toBe("run_end"));
    expect(chunks().map((c) => c.type)).toEqual(["run_start", "user", "text", "usage", "run_end"]);
    expect(users()).toEqual([{ type: "user", text: "hello", at: expect.any(Number) }]);
  });

  test("a message pi rejects goes back to the message box", async () => {
    startSession();
    await ready(0);
    await session.prompt("reject:busy");
    expect(events).toContainEqual({ type: "restore", text: "reject:busy" });
    expect(users()).toEqual([]);
  });
});
