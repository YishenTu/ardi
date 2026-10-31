import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";

import { buildPiLaunchSpec } from "../../../src/bridge/launch";

const TARGETS = resolve(import.meta.dirname, "../../../src/targets");

afterEach(() => setSystemTime());

for (const name of readdirSync(TARGETS, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name)) {
  describe(`${name} Pi extension`, () => {
    async function load() {
      const handlers: Record<string, (event: any) => unknown> = {};
      const tools: string[] = [];
      const { default: register } = await import(`${TARGETS}/${name}/agent/extension/index.ts`);
      register({
        registerTool: (tool: { name: string }) => tools.push(tool.name),
        on: (event: string, handler: (event: any) => unknown) => (handlers[event] = handler),
      });
      const { default: target } = await import(`${TARGETS}/${name}/target.json`);
      return { handlers, tools, target: target as { tools: string[] } };
    }

    // pi's own prompt has no date, so the extension adds one to every run.
    test("each run's system prompt says what day it is", async () => {
      const { handlers } = await load();
      setSystemTime(new Date(2026, 9, 29, 12));
      const event = { type: "before_agent_start", systemPromptOptions: { sections: { other: "kept" } as Record<string, string> } };
      await handlers.before_agent_start(event);
      expect(event.systemPromptOptions.sections).toEqual({ other: "kept", date: "Today is Thursday, October 29, 2026." });
    });

    // pi only offers the tools named in --tools, so one missing there is silently never used.
    test("every browser tool the extension registers is enabled when the bridge launches pi", async () => {
      const { tools, target } = await load();
      const { args } = buildPiLaunchSpec({ extension: "", tools: target.tools });
      const enabled = args[args.indexOf("--tools") + 1].split(",");
      expect(tools.length).toBeGreaterThan(0);
      expect(enabled).toEqual(expect.arrayContaining(tools));
    });
  });
}
