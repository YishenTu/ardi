// The pi child process. A trimmed take on Claudian's PiSubprocess
// (src/providers/pi/runtime/PiSubprocess.ts), without ManagedStdioProcess.
// Windows launchers are resolved before this (runtime/spawnable.ts).

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";

import type { PiLaunchSpec } from "../launch";

const STDERR_BUFFER_LIMIT = 8_000;
// How long pi gets to exit after its stdin closes before it's killed.
const SHUTDOWN_GRACE_MS = 1_000;

type CloseListener = (error?: Error) => void;

export class PiProcess {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly closeListeners = new Set<CloseListener>();
  private closed = false;
  private stderrTail = "";

  constructor(spec: PiLaunchSpec) {
    this.child = spawn(spec.command, spec.args, { cwd: spec.cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    // Forward pi's diagnostics to our stderr (stdout is the Chrome channel)
    // and keep a tail for error messages.
    this.child.stderr.on("data", (chunk: Buffer) => {
      process.stderr.write(chunk);
      this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(-STDERR_BUFFER_LIMIT);
    });
    this.child.on("error", (error) => this.notifyClose(error));
    this.child.on("exit", (code, signal) => {
      this.notifyClose(code === 0 && signal === null ? undefined : new Error(`pi exited (${signal ? `signal ${signal}` : `code ${code}`})`));
    });
  }

  get stdin() {
    return this.child.stdin;
  }

  get stdout() {
    return this.child.stdout;
  }

  get stderrSnapshot(): string {
    return this.stderrTail.trim();
  }

  onClose(listener: CloseListener): void {
    this.closeListeners.add(listener);
  }

  // Closing stdin asks pi for an orderly shutdown; a pi that doesn't exit in
  // time is killed. Resolves once it's gone. An exit asked for isn't a failure.
  shutdown(): Promise<void> {
    this.closeListeners.clear();
    if (this.closed) return Promise.resolve();
    const exited = new Promise<void>((done) => this.child.once("exit", () => done()));
    this.child.stdin.end();
    const timer = setTimeout(() => this.kill(), SHUTDOWN_GRACE_MS);
    return exited.finally(() => clearTimeout(timer));
  }

  // On Windows, killing pi leaves its own children (PowerShell, say)
  // running, so the whole tree goes.
  private kill(): void {
    if (process.platform === "win32" && this.child.pid) {
      spawn("taskkill.exe", ["/pid", String(this.child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true }).on("error", () => this.child.kill());
    } else {
      this.child.kill();
    }
  }

  private notifyClose(error?: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const listener of this.closeListeners) listener(error);
    this.closeListeners.clear();
  }
}
