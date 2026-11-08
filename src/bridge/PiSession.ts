// One pi process and the session it's on. Starts pi, proves it resumed the
// requested session, reads that session's history, and turns pi's events
// into chat chunks. What the user sends goes through PiInput, in order with
// starting and switching sessions.

import { existsSync } from "node:fs";
import { resolve } from "node:path";

import type { ImageAttachment, ModelInfo, ModelState, PiCommand, QueueAction, ThinkingLevel } from "../chat";
import { readPiHistory } from "./history/piHistory";
import { PiInput } from "./PiInput";
import { buildPiLaunchSpec, prepareWorkDir, type PiTarget } from "./launch";
import { toModelInfo } from "./models";
import { createPiEventNormalizationState, normalizePiRPCEvent } from "./normalization/piEventNormalization";
import type { BridgeEvent, SessionUpdate } from "./protocol";
import { PiProcess } from "./runtime/PiProcess";
import { PiRPCTransport } from "./runtime/PiRPCTransport";

type PiState = {
  sessionFile?: string;
  model?: { provider: string; id: string };
  thinkingLevel?: ThinkingLevel;
};

// Not started; starting (its launch is the first step in line); pi's
// process; then stopped for good (shut down, or a fatal error), after which
// nothing more is started, sent or reported.
type Phase =
  | { state: "idle" }
  | { state: "starting" }
  | { state: "running"; process: PiProcess; transport: PiRPCTransport }
  | { state: "stopped" };

export class PiSession {
  private phase: Phase = { state: "idle" };
  // The epoch of the start or open that put pi on its current session.
  private epoch = 0;
  private models: ModelInfo[] = [];
  private commands: PiCommand[] = [];
  private readonly input: PiInput;

  constructor(
    private readonly target: PiTarget,
    private readonly send: (event: BridgeEvent) => void,
    // Called after a fatal error is sent: the bridge can't go on.
    private readonly exit: (code: number) => void = (code) => process.exit(code),
  ) {
    this.input = new PiInput((event) => (event.type === "chunk" || event.type === "queue" ? this.emit(event) : this.send(event)));
  }

  // `epoch` labels what pi reports about this session.
  start(sessionFile: string | undefined, epoch: number, piPath?: string): void {
    if (this.phase.state !== "idle") return;
    this.phase = { state: "starting" };
    this.epoch = epoch;
    this.preview(sessionFile, epoch);
    this.input.exclusive(() => this.launch(sessionFile, piPath)).catch((error: unknown) => this.fail(error));
  }

  // Moves the running pi to another session (or a fresh one) without
  // restarting it. Input sent meanwhile waits for the switch.
  open(sessionFile: string | undefined, epoch: number): void {
    if (this.phase.state === "idle") return this.start(sessionFile, epoch);
    this.preview(sessionFile, epoch);
    this.input.exclusive(() => this.switchTo(sessionFile, epoch)).catch((error: unknown) => this.fail(error));
  }

  prompt(text: string, options: { promptId?: string; images?: ImageAttachment[]; steer?: boolean } = {}): Promise<void> {
    return this.input.prompt(text, options);
  }

  queueAction(action: QueueAction): Promise<void> {
    return this.input.queueAction(action);
  }

  abort(): Promise<void> {
    return this.input.stop();
  }

  // Summarizes the conversation to free up context. Progress (and failure)
  // arrives as compaction events, so it doesn't hold up input meanwhile.
  compact(): Promise<void> {
    return this.input.exclusive(async () => {
      void this.transport?.request("compact", {}, 10 * 60_000).catch(() => undefined);
    });
  }

  setModel(provider: string, modelId: string): Promise<void> {
    return this.input.exclusive(async () => {
      await this.transport?.request("set_model", { provider, modelId }).catch((error: unknown) => this.notice(error));
      await this.emitModel();
    });
  }

  setThinkingLevel(level: ThinkingLevel): Promise<void> {
    return this.input.exclusive(async () => {
      await this.transport?.request("set_thinking_level", { level }).catch((error: unknown) => this.notice(error));
      await this.emitModel();
    });
  }

  shutdown(): Promise<void> {
    const { phase } = this;
    this.phase = { state: "stopped" };
    return phase.state === "running" ? phase.process.shutdown() : Promise.resolve();
  }

  private get transport(): PiRPCTransport | undefined {
    return this.phase.state === "running" ? this.phase.transport : undefined;
  }

  private emit(event: SessionUpdate): void {
    this.send({ ...event, epoch: this.epoch });
  }

  // Sends a saved session's history straight from its file, without waiting
  // for pi; `ready` brings it again once pi is on the session.
  private preview(sessionFile: string | undefined, epoch: number): void {
    const file = saved(sessionFile);
    if (!file) return;
    readPiHistory(file).then(
      (history) => this.send({ type: "history", sessionFile: file, history, epoch }),
      () => undefined,
    );
  }

  private async launch(sessionFile?: string, piPath?: string): Promise<void> {
    // Shut down before its turn came.
    if (this.phase.state !== "starting") return;
    prepareWorkDir();
    const resumeFile = saved(sessionFile);
    const proc = new PiProcess(buildPiLaunchSpec(this.target, resumeFile, piPath));
    const transport = new PiRPCTransport({ input: proc.stdout, output: proc.stdin });
    proc.onClose((error) => this.fail(error ?? new Error("pi exited"), proc.stderrSnapshot));
    const normalization = createPiEventNormalizationState();
    transport.onEvent((event) => {
      this.input.observe(event);
      for (const chunk of normalizePiRPCEvent(event, normalization)) this.emit({ type: "chunk", chunk });
    });
    transport.start();
    this.phase = { state: "running", process: proc, transport };

    const { models } = await transport.request<{ models: Parameters<typeof toModelInfo>[0] }>("get_available_models");
    this.models = toModelInfo(models);
    const { commands } = await transport.request<{ commands: PiCommand[] }>("get_commands");
    this.commands = commands.map(({ name, description }) => ({ name, description }));
    await this.reportSession(resumeFile);
    this.input.connect(transport);
  }

  private async switchTo(sessionFile: string | undefined, epoch: number): Promise<void> {
    const transport = this.transport;
    if (!transport) return;
    // pi can't change session mid-run, and its queue belongs to the old one.
    await this.input.discard();
    await transport.request("abort").catch(() => undefined);
    const resumeFile = saved(sessionFile);
    if (resumeFile) await transport.request("switch_session", { sessionPath: resumeFile });
    else await transport.request("new_session");
    // What pi reports from here on is about the new session.
    this.epoch = epoch;
    this.input.reset();
    await this.reportSession(resumeFile);
  }

  // Proves pi is on the requested session, then reports it with its history.
  private async reportSession(resumeFile?: string): Promise<void> {
    const state = await this.transport!.request<PiState>("get_state");
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
    if (this.phase.state === "stopped") return;
    this.phase = { state: "stopped" };
    this.send({ type: "fatal", message: [errorMessage(error), stderr].filter(Boolean).join("\n") });
    this.exit(1);
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
