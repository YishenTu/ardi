// One pi process and the session it's on. Starts pi, proves it resumed the
// requested session, reads that session's history, and turns pi's events
// into chat chunks.

import { existsSync } from "node:fs";
import { resolve } from "node:path";

import type { ModelInfo, ModelState, PiCommand, ThinkingLevel } from "../chat";
import { readPiHistory } from "./history/piHistory";
import { buildPiLaunchSpec, prepareWorkDir, type PiTarget } from "./launch";
import { toModelInfo } from "./models";
import { createPiEventNormalizationState, normalizePiRPCEvent } from "./normalization/piEventNormalization";
import type { BridgeEvent } from "./protocol";
import { PiProcess } from "./runtime/PiProcess";
import { PiRPCTransport } from "./runtime/PiRPCTransport";

type PiState = {
  sessionFile?: string;
  model?: { provider: string; id: string };
  thinkingLevel?: ThinkingLevel;
};

export class PiSession {
  private process: PiProcess | null = null;
  private transport: PiRPCTransport | null = null;
  // Resolves once pi is up and on the right session; input waits for it.
  private ready: Promise<void> | null = null;
  private models: ModelInfo[] = [];
  private commands: PiCommand[] = [];
  // Set once the browser disconnects: closing pi's stdin then fails its
  // pending requests, which is expected, not fatal.
  private stopping = false;

  constructor(
    private readonly target: PiTarget,
    private readonly emit: (event: BridgeEvent) => void,
  ) {}

  start(sessionFile?: string, piPath?: string): void {
    if (this.ready) return;
    this.preview(sessionFile);
    this.ready = this.launch(sessionFile, piPath).catch((error: unknown) => this.fail(error));
  }

  // Moves the running pi to another session (or a fresh one) without
  // restarting it. Input sent meanwhile waits for the switch.
  open(sessionFile?: string): void {
    if (!this.ready) return this.start(sessionFile);
    this.preview(sessionFile);
    this.ready = this.ready.then(() => this.switchTo(sessionFile)).catch((error: unknown) => this.fail(error));
  }

  async prompt(text: string, promptId?: string): Promise<void> {
    await this.ready;
    // Only a newly started run restores browser permission. Rejected, queued
    // or handled input must not unlock browser calls from an earlier run.
    const accepted = await this.transport?.request<{ disposition: string }>("prompt", { message: text }).catch((error: unknown) => { this.notice(error); return undefined; });
    if (promptId) this.emit({ type: "prompt_result", promptId, started: accepted?.disposition === "started" });
  }

  async abort(): Promise<void> {
    await this.ready;
    await this.transport?.request("abort").catch((error: unknown) => this.notice(error));
  }

  // Summarizes the conversation to free up context. Progress arrives as
  // compaction events.
  async compact(): Promise<void> {
    await this.ready;
    // A failure also arrives as compaction_end, which reports it.
    await this.transport?.request("compact", {}, 10 * 60_000).catch(() => undefined);
  }

  async setModel(provider: string, modelId: string): Promise<void> {
    await this.ready;
    await this.transport?.request("set_model", { provider, modelId }).catch((error: unknown) => this.notice(error));
    await this.emitModel();
  }

  async setThinkingLevel(level: ThinkingLevel): Promise<void> {
    await this.ready;
    await this.transport?.request("set_thinking_level", { level }).catch((error: unknown) => this.notice(error));
    await this.emitModel();
  }

  // Sends a saved session's history straight from its file, without waiting
  // for pi; `ready` brings it again once pi is on the session.
  private preview(sessionFile?: string): void {
    const file = saved(sessionFile);
    if (!file) return;
    readPiHistory(file).then(
      (history) => this.emit({ type: "history", sessionFile: file, history }),
      () => undefined,
    );
  }

  shutdown(): Promise<void> {
    this.stopping = true;
    return this.process?.shutdown() ?? Promise.resolve();
  }

  private async launch(sessionFile?: string, piPath?: string): Promise<void> {
    prepareWorkDir();
    const resumeFile = saved(sessionFile);
    const proc = new PiProcess(buildPiLaunchSpec(this.target, resumeFile, piPath));
    const transport = new PiRPCTransport({ input: proc.stdout, output: proc.stdin });
    proc.onClose((error) => this.fail(error ?? new Error("pi exited"), proc.stderrSnapshot));
    const normalization = createPiEventNormalizationState();
    transport.onEvent((event) => {
      for (const chunk of normalizePiRPCEvent(event, normalization)) this.emit({ type: "chunk", chunk });
    });
    transport.start();
    this.process = proc;
    this.transport = transport;

    const { models } = await transport.request<{ models: Parameters<typeof toModelInfo>[0] }>("get_available_models");
    this.models = toModelInfo(models);
    const { commands } = await transport.request<{ commands: PiCommand[] }>("get_commands");
    this.commands = commands.map(({ name, description }) => ({ name, description }));
    await this.reportSession(resumeFile);
  }

  private async switchTo(sessionFile?: string): Promise<void> {
    const transport = this.transport!;
    // pi can't change session mid-run.
    await transport.request("abort").catch(() => undefined);
    const resumeFile = saved(sessionFile);
    if (resumeFile) await transport.request("switch_session", { sessionPath: resumeFile });
    else await transport.request("new_session");
    await this.reportSession(resumeFile);
  }

  // Proves pi is on the requested session, then reports it with its history.
  private async reportSession(resumeFile?: string): Promise<void> {
    const transport = this.transport!;
    const state = await transport.request<PiState>("get_state");
    if (resumeFile && (!state.sessionFile || resolve(state.sessionFile) !== resolve(resumeFile))) {
      throw new Error(`pi opened ${state.sessionFile ?? "no session file"} instead of ${resumeFile}`);
    }
    const history = state.sessionFile && existsSync(state.sessionFile) ? await readPiHistory(state.sessionFile) : [];
    this.emit({ type: "ready", sessionFile: state.sessionFile, history, model: this.modelState(state), commands: this.commands });
  }

  // Reads back what pi settled on: setting a model can also change the thinking level.
  private async emitModel(): Promise<void> {
    const state = await this.transport?.request<PiState>("get_state").catch(() => undefined);
    if (state) this.emit({ type: "model", model: this.modelState(state) });
  }

  private modelState(state: PiState): ModelState {
    const current = state.model && { provider: state.model.provider, id: state.model.id };
    return { models: this.models, current, thinkingLevel: state.thinkingLevel };
  }

  private notice(error: unknown): void {
    this.emit({ type: "chunk", chunk: { type: "notice", content: errorMessage(error), level: "error" } });
  }

  private fail(error: unknown, stderr?: string): void {
    if (this.stopping) return;
    this.emit({ type: "fatal", message: [errorMessage(error), stderr].filter(Boolean).join("\n") });
    process.exit(1);
  }
}

// pi only saves a session after its first message and exits when asked to
// resume one it never saved, so resume only files that exist.
function saved(sessionFile?: string): string | undefined {
  return sessionFile && existsSync(sessionFile) ? sessionFile : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
