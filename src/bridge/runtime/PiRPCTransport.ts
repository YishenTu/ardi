// Requests to pi's RPC mode (docs/rpc.md) and its events, over its stdin and
// stdout. Started from Claudian (src/providers/pi/runtime/PiRPCTransport.ts).
// Reads from the moment it's made, handing every event to one handler, until
// it's disposed (pi's stdout ended, or its stdin closed or failed); then
// every pending request fails. `onAnswer` lets a caller see its answer in order with pi's events.
import type { Readable } from 'node:stream';

import { subscribePiJSONLLines, writePiJSONL } from './PiJSONL';

const DEFAULT_TIMEOUT_MS = 30_000;

export type PiRPCRecord = Record<string, unknown>;
export type PiRPCEventHandler = (event: PiRPCRecord) => void;

export interface PiRPCStreams {
  input: Readable | NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
}

interface PendingRequest {
  timer?: ReturnType<typeof setTimeout>;
  onAnswer?: (data: unknown) => void;
  reject: (error: Error) => void;
  resolve: (response: unknown) => void;
  type: string;
}

export class PiRPCTransportClosedError extends Error {
  constructor(message = 'Pi RPC transport closed') {
    super(message);
    this.name = 'PiRPCTransportClosedError';
  }
}

export class PiRPCResponseError extends Error {
  constructor(
    readonly commandType: string,
    message: string,
  ) {
    super(message);
    this.name = 'PiRPCResponseError';
  }
}

export class PiRPCTransport {
  private disposed = false;
  private nextId = 1;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly unsubscribeLines: () => void;
  private readonly handleOutputError = (error: unknown): void => {
    this.dispose(error instanceof Error ? error : new Error(String(error)));
  };
  private readonly handleOutputClose = (): void => {
    this.dispose(new PiRPCTransportClosedError('Pi RPC output closed'));
    this.streams.output.off('error', this.handleOutputError);
    this.streams.output.off('close', this.handleOutputClose);
  };

  constructor(
    private readonly streams: PiRPCStreams,
    private readonly onEvent: PiRPCEventHandler,
  ) {
    // Kept past dispose(): a write in flight can still fail, and an
    // unhandled stream error would take the bridge down.
    streams.output.on('error', this.handleOutputError);
    streams.output.on('close', this.handleOutputClose);
    this.unsubscribeLines = subscribePiJSONLLines(
      streams.input,
      (line) => this.handleLine(line),
      () => this.dispose(new PiRPCTransportClosedError('Pi RPC input closed')),
      (error) => this.dispose(error),
    );
  }

  request<T = unknown>(
    commandType: string,
    payload: Record<string, unknown> = {},
    timeoutMs = DEFAULT_TIMEOUT_MS,
    // Called with a successful answer as it's read, before events read after
    // it; the returned promise settles only after the whole read.
    onAnswer?: (data: unknown) => void,
  ): Promise<T> {
    if (this.disposed) {
      return Promise.reject(new PiRPCTransportClosedError());
    }

    const id = `req_${this.nextId++}`;
    return new Promise<T>((resolve, reject) => {
      // 0: no timeout.
      const timer = timeoutMs > 0 ? setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request timeout: ${commandType} (${timeoutMs}ms)`));
      }, timeoutMs) : undefined;

      this.pending.set(id, {
        timer,
        onAnswer,
        reject,
        resolve: (response: unknown) => resolve(response as T),
        type: commandType,
      });

      try {
        writePiJSONL(this.streams.output, { id, type: commandType, ...payload });
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        const transportError = error instanceof Error ? error : new Error(String(error));
        this.dispose(transportError);
        reject(transportError);
      }
    });
  }

  // A record pi answers with nothing, such as an `extension_ui_response`.
  send(record: PiRPCRecord): void {
    if (this.disposed) return;
    writePiJSONL(this.streams.output, record);
  }

  dispose(error: Error = new PiRPCTransportClosedError('Pi RPC transport disposed')): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    this.unsubscribeLines();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private handleLine(line: string): void {
    // Disposed earlier in the same read (by a handler, say).
    if (this.disposed || !line.trim()) {
      return;
    }

    let record: PiRPCRecord;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!isPlainObject(parsed)) {
        return;
      }
      record = parsed;
    } catch {
      return;
    }

    if (record.type === 'response' && typeof record.id === 'string') {
      this.handleResponse(record.id, record);
      return;
    }

    this.onEvent(record);
  }

  private handleResponse(id: string, record: PiRPCRecord): void {
    const pending = this.pending.get(id);
    if (!pending) {
      return;
    }

    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (record.success === false) {
      const errorText = typeof record.error === 'string'
        ? record.error
        : `Pi RPC command failed: ${pending.type}`;
      pending.reject(new PiRPCResponseError(pending.type, errorText));
      return;
    }

    const data = 'data' in record ? record.data : record;
    pending.onAnswer?.(data);
    pending.resolve(data);
  }
}

function isPlainObject(value: unknown): value is PiRPCRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
