// A fake of the chrome.* APIs Ardi uses, installed as the global `chrome` by
// test/setup.ts and reset after each test. Tests script the native host and
// the background through it.

type Listener = (...args: any[]) => unknown;

class Event {
  private readonly listeners: Listener[] = [];
  addListener(listener: Listener) {
    this.listeners.push(listener);
  }
  emit(...args: unknown[]): unknown[] {
    return this.listeners.map((listener) => listener(...args));
  }
}

// One end of a chrome.runtime.Port. `sent` is what the code under test
// posted; `receive` and `close` act as the other end.
export class FakePort {
  readonly sent: any[] = [];
  readonly onMessage = new Event();
  readonly onDisconnect = new Event();
  disconnected = false;
  // Answers each posted message, like the other end would.
  onPost?: (message: any) => void;

  constructor(readonly name: string) {}

  // This port, typed as the real thing for code that takes one.
  get port(): chrome.runtime.Port {
    return this as unknown as chrome.runtime.Port;
  }

  postMessage(message: unknown) {
    // Like Chrome, which throws on a disconnected port.
    if (this.disconnected) throw new Error("Attempting to use a disconnected port object");
    this.sent.push(message);
    this.onPost?.(message);
  }

  disconnect() {
    this.disconnected = true;
  }

  receive(message: unknown) {
    this.onMessage.emit(message, this);
  }

  // The other end went away, optionally with chrome.runtime.lastError set.
  close(error?: string) {
    this.disconnected = true;
    fake.lastError = error ? { message: error } : undefined;
    this.onDisconnect.emit(this);
    fake.lastError = undefined;
  }
}

const fake = {
  storage: new Map<string, unknown>(),
  nativePorts: [] as FakePort[],
  // Called for each native connection, to script the bridge.
  onConnectNative: undefined as ((port: FakePort) => void) | undefined,
  // Answers chrome.runtime.sendMessage.
  onSendMessage: undefined as ((message: any) => unknown) | undefined,
  lastError: undefined as { message: string } | undefined,
  // What chrome.tabs.query returns.
  tabs: [] as Partial<chrome.tabs.Tab>[],
};

export function resetChrome() {
  fake.storage.clear();
  fake.nativePorts.length = 0;
  fake.onConnectNative = undefined;
  fake.onSendMessage = undefined;
  fake.lastError = undefined;
  fake.tabs = [];
}

export const chromeFake = fake;

(globalThis as any).chrome = {
  storage: {
    local: {
      async get(key: string) {
        return fake.storage.has(key) ? { [key]: structuredClone(fake.storage.get(key)) } : {};
      },
      async set(items: Record<string, unknown>) {
        for (const [key, value] of Object.entries(items)) fake.storage.set(key, structuredClone(value));
      },
    },
  },
  runtime: {
    get lastError() {
      return fake.lastError;
    },
    connectNative(name: string) {
      const port = new FakePort(name);
      fake.nativePorts.push(port);
      fake.onConnectNative?.(port);
      return port;
    },
    async sendMessage(message: unknown) {
      return fake.onSendMessage?.(message);
    },
    getURL: (path: string) => `chrome-extension://ardi${path}`,
  },
  tabs: {
    async query() {
      return structuredClone(fake.tabs);
    },
  },
};
