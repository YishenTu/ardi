// The pi child process. A trimmed take on Claudian's PiSubprocess
// (src/providers/pi/runtime/PiSubprocess.ts): no Windows launcher handling,
// no ManagedStdioProcess.

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";

import type { PiLaunchSpec } from "../launch";

const STDERR_BUFFER_LIMIT = 8_000;

type CloseListener = (error?: Error) => void;

export class PiProcess {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly closeListeners = new Set<CloseListener>();
  private closed = false;
  private stderrTail = "";

  constructor(spec: PiLaunchSpec) {
    this.child = spawn(spec.command, spec.args, { cwd: spec.cwd, stdio: ["pipe", "pipe", "pipe"] });
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

  // Closing stdin asks pi for an orderly shutdown.
  shutdown(): void {
    this.child.stdin.end();
  }

  private notifyClose(error?: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const listener of this.closeListeners) listener(error);
    this.closeListeners.clear();
  }
}
