import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { buildPiLaunchSpec, piCommand, prepareWorkDir, SHELL_TOOL, WORK_DIR } from "../../../src/bridge/launch";

afterEach(() => {
  delete process.env.ARDI_PI_BIN;
});

describe("piCommand", () => {
  test("with no path, uses the pi host:install found, else pi on PATH", () => {
    expect(piCommand()).toBe("pi");
    expect(piCommand("  ")).toBe("pi");
    process.env.ARDI_PI_BIN = "/opt/bin/pi";
    expect(piCommand("")).toBe("/opt/bin/pi");
  });

  test("expands ~ to the home folder", () => {
    writeFileSync(join(homedir(), "my-pi"), "");
    expect(piCommand("~/my-pi")).toBe(join(homedir(), "my-pi"));
  });

  test.if(process.platform === "win32")("expands ~\\ on Windows", () => {
    writeFileSync(join(homedir(), "my-pi"), "");
    expect(piCommand("~\\my-pi")).toBe(join(homedir(), "my-pi"));
  });

  test("rejects a path that doesn't exist or isn't a file, pointing at Settings", () => {
    expect(() => piCommand("/nowhere/pi")).toThrow("Pi not found at /nowhere/pi. Fix the path in Settings.");
    mkdirSync(join(homedir(), "a-folder"), { recursive: true });
    expect(() => piCommand("~/a-folder")).toThrow("is not a file");
  });
});

const TARGET = { extension: "/dist/test/agent/extension", tools: ["list_tabs", "browser_exec"] };

describe("buildPiLaunchSpec", () => {
  // Not whatever pi is on the developer's PATH: on Windows, an npm pi.cmd
  // there would put its script ahead of pi's arguments.
  beforeEach(() => { process.env.ARDI_PI_BIN = join(homedir(), "pi"); });

  test("runs pi in RPC mode in ~/.ardi, isolated from the user's own pi setup except AGENTS.md", () => {
    const spec = buildPiLaunchSpec(TARGET);
    expect(spec.cwd).toBe(join(homedir(), ".ardi"));
    expect(spec.args.slice(0, 2)).toEqual(["--mode", "rpc"]);
    for (const flag of ["--no-extensions", "--no-skills", "--no-prompt-templates"]) expect(spec.args).toContain(flag);
    // AGENTS.md loads the way pi normally does it, so ~/.ardi/AGENTS.md holds the user's instructions for Ardi.
    expect(spec.args).not.toContain("--no-context-files");
    // Ardi's own prompt, extension and skills come back in explicitly.
    expect(spec.args[spec.args.indexOf("--system-prompt") + 1]).toEndWith(join("src", "agent", "system-prompt.md"));
    expect(spec.args[spec.args.indexOf("--extension") + 1]).toBe(TARGET.extension);
    expect(spec.args[spec.args.indexOf("--skill") + 1]).toBe(join(WORK_DIR, ".agents", "skills"));
    expect(spec.args[spec.args.indexOf("--tools") + 1].split(",")).toEqual(expect.arrayContaining(["read", SHELL_TOOL, ...TARGET.tools]));
  });

  test("resumes a session only when given one", () => {
    expect(buildPiLaunchSpec(TARGET).args).not.toContain("--session");
    const args = buildPiLaunchSpec(TARGET, "/s/chat.jsonl").args;
    expect(args[args.indexOf("--session") + 1]).toBe("/s/chat.jsonl");
  });
});

describe("prepareWorkDir", () => {
  test("preserves an existing references link owned by an older installation", () => {
    mkdirSync(WORK_DIR, { recursive: true });
    const refs = join(WORK_DIR, "references");
    rmSync(refs, { force: true });
    const old = resolve("/old/checkout/src/agent/references");
    symlinkSync(old, refs);
    prepareWorkDir();
    expect(readlinkSync(refs)).toBe(old);
  });
});
