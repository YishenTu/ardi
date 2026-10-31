// A fake of the chrome.* APIs Ardi uses, installed as the global `chrome` by
// test/setup.ts and reset after each test. Tests script the native host and
// the background through it.

type Listener = (...args: any[]) => unknown;

class Event {
  private readonly listeners: Listener[] = [];
  addListener(listener: Listener) {
    this.listeners.push(listener);
  }
  removeListener(listener: Listener) {
    const index = this.listeners.indexOf(listener);
    if (index >= 0) this.listeners.splice(index, 1);
  }
  clear() { this.listeners.length = 0; }
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
  focusedWindow: 1,
  createdTabs: [] as chrome.tabs.CreateProperties[],
  debuggerAttached: [] as number[],
  debuggerDetached: [] as number[],
  debuggerCommands: [] as { target: chrome.debugger.Debuggee; method: string; params?: object }[],
  debuggerDetach: new Event(),
  onDebuggerCommand: undefined as ((method: string, params?: object) => unknown) | undefined,
};

export function resetChrome() {
  fake.storage.clear();
  fake.nativePorts.length = 0;
  fake.onConnectNative = undefined;
  fake.onSendMessage = undefined;
  fake.lastError = undefined;
  fake.tabs = [];
  fake.focusedWindow = 1;
  fake.createdTabs = [];
  fake.debuggerAttached = [];
  fake.debuggerDetached = [];
  fake.debuggerCommands = [];
  fake.debuggerDetach.clear();
  fake.onDebuggerCommand = undefined;
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
  debugger: {
    onDetach: fake.debuggerDetach,
    async attach(target: chrome.debugger.Debuggee) { fake.debuggerAttached.push(target.tabId!); },
    async detach(target: chrome.debugger.Debuggee) { fake.debuggerDetached.push(target.tabId!); },
    async sendCommand(target: chrome.debugger.Debuggee, method: string, params?: object) {
      fake.debuggerCommands.push({ target, method, params });
      return fake.onDebuggerCommand?.(method, params) ?? {};
    },
  },
  tabs: {
    async query(query: chrome.tabs.QueryInfo = {}) {
      return structuredClone(fake.tabs.filter(t => (!query.active || t.active) && (!query.lastFocusedWindow || t.windowId === fake.focusedWindow)));
    },
    async get(id: number) {
      const tab = fake.tabs.find(t => t.id === id);
      if (!tab) throw new Error(`No tab with id ${id}`);
      return structuredClone(tab);
    },
    async create(props: chrome.tabs.CreateProperties) {
      fake.createdTabs.push(props);
      const tab = { id: 100 + fake.createdTabs.length, url: props.url, title: "New page", active: props.active, windowId: fake.focusedWindow, status: "complete" as const };
      fake.tabs.push(tab);
      return structuredClone(tab);
    },
    async remove(id: number) { fake.tabs = fake.tabs.filter(t => t.id !== id); },
  },
};
