import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";

import ardi from "../../../../src/agent/extension/index";
import { buildPiLaunchSpec } from "../../../../src/bridge/launch";

let handlers: Record<string, (event: any) => unknown>;
let tools: string[];

beforeEach(() => {
  handlers = {};
  tools = [];
  ardi({
    registerTool: (tool: { name: string }) => tools.push(tool.name),
    on: (name: string, handler: (event: any) => unknown) => (handlers[name] = handler),
  } as any);
});

afterEach(() => setSystemTime());

// The prompt sections one run starts with.
async function run(sections: Record<string, string> = {}) {
  const event = { type: "before_agent_start", systemPromptOptions: { sections } };
  await handlers.before_agent_start(event);
  return event.systemPromptOptions.sections;
}

// pi's own prompt has no date, so the extension adds one to every run.
test("each run's system prompt says what day it is", async () => {
  setSystemTime(new Date(2026, 9, 29, 12));
  expect(await run({ other: "kept" })).toEqual({ other: "kept", date: "Today is Thursday, October 29, 2026." });
});

// pi only offers the tools named in --tools, so one missing there is silently never used.
test("every browser tool the extension registers is enabled when the bridge launches pi", () => {
  const { args } = buildPiLaunchSpec();
  const enabled = args[args.indexOf("--tools") + 1].split(",");
  expect(tools.length).toBeGreaterThan(0);
  expect(enabled).toEqual(expect.arrayContaining(tools));
});
