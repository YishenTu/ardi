// How Ardi launches pi. Inspired by Claudian's PiLaunchSpecBuilder.

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type { PiCheck } from "./protocol";
import { spawnable } from "./runtime/spawnable";

// pi always runs here. Its sessions are stored per working folder, so a
// fixed folder keeps all of Ardi's sessions together and resumable.
export const WORK_DIR = join(homedir(), ".ardi");

// Ardi's own skills. The only skills pi loads; the user's global ones
// (~/.agents/skills, ~/.pi/agent/skills) stay out.
export const SKILLS_DIR = join(WORK_DIR, ".agents", "skills");

// Pi's shared system prompt: src/agent/ from source, the copy in
// dist/<target>/agent/ when built.
const SYSTEM_PROMPT = resolve(import.meta.dirname, "../agent/system-prompt.md");

// Every built-in tool. Named explicitly, with the target's browser tools, so
// the user's own pi `defaultTools` setting doesn't change what Ardi gets.
// Windows gets PowerShell instead of bash, so Git Bash isn't required.
export const SHELL_TOOL = process.platform === "win32" ? "powershell" : "bash";
const TOOLS = ["read", SHELL_TOOL, "edit", "write", "grep", "find", "ls", "codemode"];

// What one browser target adds to pi: its extension directory (pi loads its
// index.ts from source, the bundled index.js from dist) and the tools it registers.
export interface PiTarget {
  extension: string;
  tools: readonly string[];
}

export interface PiLaunchSpec {
  command: string;
  args: string[];
  cwd: string;
}

// pi runs isolated from the user's own pi setup: only Ardi's prompt, the
// target's extension, the tool list and Ardi's skills; no global extensions, skills or prompt
// templates. AGENTS.md files load the way pi normally does it (its agent
// folder, the working folder and its parents), so ~/.ardi/AGENTS.md holds the
// user's instructions for Ardi.
// `sessionFile`: resume that session; omitted = pi starts a new one.
// `piPath`: the user's pi from Settings; omitted = the installed pi.
export function buildPiLaunchSpec(target: PiTarget, sessionFile?: string, piPath?: string): PiLaunchSpec {
  const args = [
    "--mode", "rpc",
    "--system-prompt", SYSTEM_PROMPT,
    "--no-extensions",
    "--extension", target.extension,
    "--tools", [...TOOLS, ...target.tools].join(","),
    "--no-skills",
    "--skill", SKILLS_DIR,
    "--no-prompt-templates",
  ];
  if (sessionFile) args.push("--session", sessionFile);
  return { ...spawnable(piCommand(piPath), args), cwd: WORK_DIR };
}

// The user's pi path (`~` expanded), or the pi `host:install` found.
// Throws if a user path isn't a file, so the error names the setting.
export function piCommand(piPath?: string): string {
  const trimmed = piPath?.trim();
  const path = trimmed && /^~(?=[\\/]|$)/.test(trimmed) ? join(homedir(), trimmed.slice(1)) : trimmed;
  if (!path) return process.env.ARDI_PI_BIN || "pi";
  if (!existsSync(path)) throw new Error(`Pi not found at ${path}. Fix the path in Settings.`);
  if (!statSync(path).isFile()) throw new Error(`${path} is not a file. Fix the path in Settings.`);
  return path;
}

// Runs `pi --version`, for the settings view.
export function checkPi(piPath?: string): Promise<PiCheck> {
  let command = piPath ?? "";
  let run: ReturnType<typeof spawnable>;
  try {
    command = piCommand(piPath);
    run = spawnable(command, ["--version"]);
  } catch (error) {
    return Promise.resolve({ command, error: (error as Error).message });
  }
  return new Promise((done) => {
    execFile(run.command, run.args, { timeout: 10_000, windowsHide: true }, (error, stdout, stderr) => {
      done(error ? { command, error: stderr.trim() || error.message } : { command, version: stdout.trim() });
    });
  });
}

// User-owned instructions and skills are shared by both distributions.
export function prepareWorkDir(): void {
  mkdirSync(SKILLS_DIR, { recursive: true });
}
