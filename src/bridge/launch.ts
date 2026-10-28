// How Ardi launches pi. Inspired by Claudian's PiLaunchSpecBuilder.

import { execFile } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readlinkSync, statSync, symlinkSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type { PiCheck } from "./protocol";

// pi always runs here. Its sessions are stored per working folder, so a
// fixed folder keeps all of Ardi's sessions together and resumable.
export const WORK_DIR = join(homedir(), ".ardi");

// Ardi's own skills. The only skills pi loads; the user's global ones
// (~/.agents/skills, ~/.pi/agent/skills) stay out.
export const SKILLS_DIR = join(WORK_DIR, ".agents", "skills");

// Ardi's agent setup, versioned in this repo under src/agent/ and copied
// into dist/agent/ by the build; the bridge uses the copy next to it.
const AGENT_DIR = resolve(import.meta.dirname, "../agent");

// Every built-in tool plus Ardi's browser tools. Named explicitly so the
// user's own pi `defaultTools` setting doesn't change what Ardi gets.
const TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls", "codemode", "list_tabs", "read_tab", "view_image", "open_tab", "ardia_exec"];

export interface PiLaunchSpec {
  command: string;
  args: string[];
  cwd: string;
}

// pi runs isolated from the user's own pi setup: only Ardi's prompt,
// extension, tool list and skills; no global extensions, skills or prompt
// templates. AGENTS.md files load the way pi normally does it (its agent
// folder, the working folder and its parents), so ~/.ardi/AGENTS.md holds the
// user's instructions for Ardi.
// `sessionFile`: resume that session; omitted = pi starts a new one.
// `piPath`: the user's pi from Settings; omitted = the installed pi.
export function buildPiLaunchSpec(sessionFile?: string, piPath?: string): PiLaunchSpec {
  const args = [
    "--mode", "rpc",
    "--system-prompt", join(AGENT_DIR, "system-prompt.md"),
    "--no-extensions",
    "--extension", join(AGENT_DIR, "extension/index.ts"),
    "--tools", TOOLS.join(","),
    "--no-skills",
    "--skill", SKILLS_DIR,
    "--no-prompt-templates",
  ];
  if (sessionFile) args.push("--session", sessionFile);
  return { command: piCommand(piPath), args, cwd: WORK_DIR };
}

// The user's pi path (`~` expanded), or the pi `host:install` found.
// Throws if a user path isn't a file, so the error names the setting.
export function piCommand(piPath?: string): string {
  const path = piPath?.trim().replace(/^~(?=\/|$)/, homedir());
  if (!path) return process.env.ARDI_PI_BIN || "pi";
  if (!existsSync(path)) throw new Error(`Pi not found at ${path}. Fix the path in Settings.`);
  if (!statSync(path).isFile()) throw new Error(`${path} is not a file. Fix the path in Settings.`);
  return path;
}

// Runs `pi --version`, for the settings view.
export function checkPi(piPath?: string): Promise<PiCheck> {
  let command: string;
  try {
    command = piCommand(piPath);
  } catch (error) {
    return Promise.resolve({ command: piPath ?? "", error: (error as Error).message });
  }
  return new Promise((done) => {
    execFile(command, ["--version"], { timeout: 10_000 }, (error, stdout, stderr) => {
      done(error ? { command, error: stderr.trim() || error.message } : { command, version: stdout.trim() });
    });
  });
}

// ~/.ardi/references -> the agent's references, so tools can point pi at
// references/*.md relative to its working folder. A link left by an older
// checkout or build location is replaced.
export function prepareWorkDir(): void {
  mkdirSync(SKILLS_DIR, { recursive: true });
  const refs = join(WORK_DIR, "references");
  const target = join(AGENT_DIR, "references");
  const link = lstatSync(refs, { throwIfNoEntry: false });
  if (link?.isSymbolicLink() && readlinkSync(refs) !== target) unlinkSync(refs);
  else if (link) return;
  symlinkSync(target, refs);
}
