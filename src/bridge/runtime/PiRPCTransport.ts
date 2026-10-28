// Adapted from Claudian (src/providers/pi/runtime/PiRPCTransport.ts): timers use Node globals instead of
// window; dropped what Ardi doesn't use (close listeners, abort signals, raw sends).
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
  cleanup: () => void;
  reject: (error: Error) => void;
  resolve: (response: unknown) => void;
  type: string;
}

export class PiRPCTransportClosedError extends Error {
  constructor(message = 'Pi RPC transport closed') {
    super(message);
    this.name = 'PiRpcTransportClosedError';
  }
}

export class PiRPCResponseError extends Error {
  constructor(
    readonly commandType: string,
    message: string,
  ) {
    super(message);
    this.name = 'PiRpcResponseError';
  }
}

export class PiRPCTransport {
  private disposed = false;
  private readonly eventHandlers = new Set<PiRPCEventHandler>();
  private nextId = 1;
  private readonly pending = new Map<string, PendingRequest>();
  private unsubscribeLines?: () => void;
  private readonly handleOutputError = (error: unknown): void => {
    this.dispose(error instanceof Error ? error : new Error(String(error)));
  };
  private readonly handleOutputClose = (): void => {
    this.dispose(new PiRPCTransportClosedError('Pi RPC output closed'));
    this.streams.output.off('error', this.handleOutputError);
    this.streams.output.off('close', this.handleOutputClose);
  };

  constructor(private readonly streams: PiRPCStreams) {}

  start(): void {
    if (this.unsubscribeLines || this.disposed) {
      return;
    }

    this.streams.output.on('error', this.handleOutputError);
    this.streams.output.on('close', this.handleOutputClose);
    this.unsubscribeLines = subscribePiJSONLLines(
      this.streams.input,
      (line) => this.#handleLine(line),
      () => {
        if (!this.disposed) {
          this.dispose(new PiRPCTransportClosedError('Pi RPC input closed'));
        }
      },
      (error) => {
        if (!this.disposed) {
          this.dispose(error);
        }
      },
    );
  }

  onEvent(handler: PiRPCEventHandler): () => void {
    this.eventHandlers.add(handler);
    return () => {
      this.eventHandlers.delete(handler);
    };
  }

  request<T = unknown>(
    commandType: string,
    payload: Record<string, unknown> = {},
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<T> {
    this.start();
    if (this.disposed) {
      return Promise.reject(new PiRPCTransportClosedError());
    }

    const id = `req_${this.nextId++}`;
    return new Promise<T>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = (): void => {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
      };

      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          this.pending.delete(id);
          cleanup();
          reject(new Error(`Request timeout: ${commandType} (${timeoutMs}ms)`));
        }, timeoutMs);
      }

      this.pending.set(id, {
        cleanup,
        reject,
        resolve: (response: unknown) => resolve(response as T),
        type: commandType,
      });

      try {
        this.#sendRaw({ id, type: commandType, ...payload });
      } catch (error) {
        this.pending.delete(id);
        cleanup();
        const transportError = error instanceof Error ? error : new Error(String(error));
        this.dispose(transportError);
        reject(transportError);
      }
    });
  }

  dispose(error: Error = new PiRPCTransportClosedError('Pi RPC transport disposed')): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    // In-flight writes can fail after disposal; own their errors until the output closes.
    this.unsubscribeLines?.();
    this.unsubscribeLines = undefined;
    this.#rejectAllPending(error);
    this.eventHandlers.clear();
  }

  #sendRaw(record: PiRPCRecord): void {
    writePiJSONL(this.streams.output, record);
  }

  #handleLine(line: string): void {
    if (!line.trim()) {
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
      this.#handleResponse(record.id, record);
      return;
    }

    for (const handler of this.eventHandlers) {
      handler(record);
    }
  }

  #handleResponse(id: string, record: PiRPCRecord): void {
    const pending = this.pending.get(id);
    if (!pending) {
      return;
    }

    this.pending.delete(id);
    pending.cleanup();
    if (record.success === false) {
      const errorText = typeof record.error === 'string'
        ? record.error
        : `Pi RPC command failed: ${pending.type}`;
      pending.reject(new PiRPCResponseError(pending.type, errorText));
      return;
    }

    if ('data' in record) {
      pending.resolve(record.data);
      return;
    }
    pending.resolve(record);
  }

  #rejectAllPending(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.cleanup();
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function isPlainObject(value: unknown): value is PiRPCRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
