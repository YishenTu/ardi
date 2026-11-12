import type { BrowserReply } from "../../../bridge/protocol";
import type { BrowserLink } from "../../../background/target";
import type { BrowserRequest, BrowserTab, InstalledUserscript, TabSelector, UserscriptRun } from "../protocol";

// One controller per native connection. All targets belong to this extension's
// browser; no browser port, process discovery or external profile is involved.
const METHODS = new Set([
  "Runtime.evaluate", "Page.captureScreenshot", "Page.navigate", "Page.reload",
  "Input.insertText", "Input.dispatchKeyEvent", "Input.dispatchMouseEvent", "Input.dispatchTouchEvent",
  "DOM.getDocument", "DOM.querySelector", "DOM.querySelectorAll", "DOM.getBoxModel", "DOM.focus", "DOM.scrollIntoViewIfNeeded",
  "Accessibility.getFullAXTree",
]);
const webPage = (url: string) => /^(https?:\/\/|about:blank$|data:|blob:)/.test(url);

// The extension's debugger attachments, shared by every controller (one per
// chat with pi running): Chrome lets the extension attach to a tab only once,
// so two chats on one tab share it, and it detaches when the last lets go.
// Per tab, one phase at a time: attached (or attaching: `pending`) with the
// controllers using it, then detaching once the last lets go, until Chrome
// is done; a controller reaching the tab meanwhile waits for that instead of
// failing.
type Attachment =
  | { phase: "attached"; pending: Promise<void>; users: Set<ChromeBrowserController> }
  | { phase: "detaching"; done: Promise<void> };
const attached = new Map<number, Attachment>();

export class ChromeBrowserController {
  private closed = false;
  private cancellation = new AbortController();
  private cancellationEpoch = 0;
  private readonly onDetach = (source: chrome.debugger.Debuggee, reason: string) => {
    if (source.tabId === undefined) return;
    attached.delete(source.tabId);
    if (reason === "canceled_by_user") this.cancel();
  };

  constructor() { chrome.debugger.onDetach.addListener(this.onDetach); }

  // Capture permission at submission, but restore it only after Pi accepts a
  // new run. A later cancellation invalidates this callback, even if repeated.
  preparePrompt(): () => void {
    const epoch = this.cancellationEpoch;
    return () => {
      if (!this.closed && epoch === this.cancellationEpoch && this.cancellation.signal.aborted) this.cancellation = new AbortController();
    };
  }

  cancel() {
    this.cancellationEpoch++;
    this.cancellation.abort(new Error("Browser control was canceled by the user; wait for their next request"));
  }

  async execute(request: BrowserRequest, signal?: AbortSignal): Promise<unknown> {
    // Capture this run's signal: a later prompt must not revive queued work.
    signal = signal ? AbortSignal.any([signal, this.cancellation.signal]) : this.cancellation.signal;
    this.checkOpen(signal);
    switch (request.op) {
      case "list": {
        const [tabs, current] = await Promise.all([chrome.tabs.query({}), this.current()]);
        return tabs.filter(t => t.id !== undefined && webPage(t.url ?? "")).map(t => this.info(t, current?.id));
      }
      case "open": {
        if (!webPage(request.url)) throw new Error("Only web page URLs are supported");
        const tab = await this.waitForLoad(await chrome.tabs.create({ url: request.url, active: request.background === false }), 20_000, signal);
        return this.info(tab, (await this.current())?.id);
      }
      case "scripts_list": {
        const scripts = await userScripts().getScripts();
        return scripts.map(({ js: _js, ...script }) => script as InstalledUserscript);
      }
      case "scripts_install": {
        const api = userScripts();
        const { code, ...script } = request.script;
        const registration = { ...script, js: [{ code }] };
        const installed = await api.getScripts({ ids: [script.id] });
        this.checkOpen(signal);
        await (installed.length ? api.update([registration]) : api.register([registration]));
        return { installed: script.id, updated: installed.length > 0 };
      }
      case "scripts_uninstall": {
        const api = userScripts();
        if (!(await api.getScripts({ ids: [request.id] })).length) throw new Error(`No installed userscript named ${request.id}; list them for their names`);
        this.checkOpen(signal);
        await api.unregister({ ids: [request.id] });
        return { uninstalled: request.id };
      }
      case "scripts_test": return await this.testScript(request.url, request.code, request.waitMs, signal);
      case "close": {
        const tab = await this.select({ id: request.id });
        this.checkOpen(signal);
        await chrome.tabs.remove(tab.id!);
        return { closed: String(tab.id) };
      }
      case "eval":
      case "cdp": {
        const tab = await this.select(request);
        const method = request.op === "eval" ? "Runtime.evaluate" : request.method;
        if (!METHODS.has(method)) throw new Error(`CDP method ${method} is not supported`);
        const navigationURL = request.op === "cdp" ? request.params?.url : undefined;
        if (method === "Page.navigate" && (typeof navigationURL !== "string" || !webPage(navigationURL))) {
          throw new Error("Only web page URLs are supported");
        }
        await this.attach(tab.id!, signal);
        this.checkOpen(signal);
        const params = request.op === "eval" ? { expression: request.code, returnByValue: true, awaitPromise: true, timeout: 20_000 } : request.params;
        const value = await chrome.debugger.sendCommand({ tabId: tab.id! }, method, params);
        const info = this.info(tab, (await this.current())?.id);
        if (request.op === "cdp") return { tab: info, value };
        const evaluated = value as { result?: { value?: unknown }; exceptionDetails?: { text?: string; exception?: { description?: string } } };
        if (evaluated.exceptionDetails) throw new Error(evaluated.exceptionDetails.exception?.description ?? evaluated.exceptionDetails.text ?? "JavaScript failed");
        return { tab: info, value: evaluated.result?.value ?? null };
      }
      default: throw new Error("Unknown browser operation");
    }
  }

  async dispose(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    chrome.debugger.onDetach.removeListener(this.onDetach);
    await Promise.all([...attached].map(async ([tabId, entry]) => {
      if (entry.phase !== "attached" || !entry.users.delete(this) || entry.users.size) return;
      const detaching: Attachment = { phase: "detaching", done: Promise.resolve() };
      attached.set(tabId, detaching);
      detaching.done = (async () => {
        try { await entry.pending; await chrome.debugger.detach({ tabId }); } catch { /* Already detached/closed. */ }
        if (attached.get(tabId) === detaching) attached.delete(tabId);
      })();
      await detaching.done;
    }));
  }

  private checkOpen(signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (this.closed) throw new Error("Browser connection disconnected");
  }
  // Waits up to `ms` for a tab to finish loading.
  private async waitForLoad(tab: chrome.tabs.Tab, ms: number, signal: AbortSignal): Promise<chrome.tabs.Tab> {
    const deadline = Date.now() + ms;
    while (tab.status !== "complete") {
      this.checkOpen(signal);
      if (Date.now() >= deadline) throw new Error(`Tab ${tab.id} is still loading; call read_tab with its id when ready`);
      await new Promise(resolve => setTimeout(resolve, 100));
      tab = await chrome.tabs.get(tab.id!);
    }
    return tab;
  }

  // Runs a script once in a background tab of its own, after the page has
  // loaded, and reports what it logged and threw while it ran and for
  // `waitMs` after. Loading (10 s), running (EVAL_MS) and watching (10 s)
  // fit in the relay's 30 s, and Stop closes the tab at any point.
  private async testScript(url: string, code: string, waitMs: number, signal: AbortSignal): Promise<UserscriptRun> {
    let tabId: number | undefined;
    const logs: string[] = [];
    const errors: string[] = [];
    let listening = false;
    const onEvent = (source: chrome.debugger.Debuggee, method: string, params?: object) => {
      if (!listening || source.tabId !== tabId) return;
      if (method === "Runtime.consoleAPICalled") {
        const { type, args } = params as { type: string; args: { value?: unknown; description?: string }[] };
        const line = args.map(a => a.description ?? (typeof a.value === "string" ? a.value : JSON.stringify(a.value))).join(" ");
        (type === "error" || type === "assert" ? errors : logs).push(type === "log" ? line : `${type}: ${line}`);
      } else if (method === "Runtime.exceptionThrown") errors.push(describe((params as { exceptionDetails: Exception }).exceptionDetails));
    };
    if (!webPage(url)) throw new Error("Only web page URLs are supported");
    chrome.debugger.onEvent.addListener(onEvent);
    try {
      const tab = await chrome.tabs.create({ url, active: false });
      const id = tabId = tab.id!;
      await this.waitForLoad(tab, 10_000, signal);
      await this.attach(id, signal);
      // Runtime.enable replays the page's earlier console messages; skip those.
      await abortable(chrome.debugger.sendCommand({ tabId: id }, "Runtime.enable"), signal);
      listening = true;
      // CDP's own timeout stops at the first await, so bound the whole run.
      const evaluated = chrome.debugger.sendCommand({ tabId: id }, "Runtime.evaluate", { expression: code, awaitPromise: true, timeout: EVAL_MS }) as Promise<{ exceptionDetails?: Exception }>;
      const result = await Promise.race([evaluated, sleep(EVAL_MS, signal).then(() => null)]);
      if (result === null) errors.push(`The script was still running after ${EVAL_MS / 1000} s; its promise never settled.`);
      else if (result.exceptionDetails) errors.push(describe(result.exceptionDetails));
      await sleep(Math.min(waitMs, 10_000), signal);
      return { tab: this.info(await chrome.tabs.get(id), (await this.current())?.id), logs, errors };
    } finally {
      chrome.debugger.onEvent.removeListener(onEvent);
      if (tabId !== undefined) {
        attached.delete(tabId);
        await chrome.tabs.remove(tabId).catch(() => {});
      }
    }
  }

  private async current() { return (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]; }
  private info(tab: chrome.tabs.Tab, currentId?: number): BrowserTab {
    return { id: String(tab.id), title: tab.title ?? "", url: tab.url ?? "", current: tab.id === currentId };
  }
  private async select(selector: TabSelector): Promise<chrome.tabs.Tab> {
    const tab = selector.id !== undefined ? await chrome.tabs.get(Number(selector.id))
      : selector.url ? (await chrome.tabs.query({})).find(t => t.url === selector.url)
      : await this.current();
    if (!tab || tab.id === undefined || !webPage(tab.url ?? "")) throw new Error("No matching web page tab; use list_tabs and select an id or URL");
    return tab;
  }
  private async attach(tabId: number, signal?: AbortSignal) {
    this.checkOpen(signal);
    let entry = attached.get(tabId);
    while (entry?.phase === "detaching") {
      await entry.done;
      this.checkOpen(signal);
      entry = attached.get(tabId);
    }
    if (!entry) {
      const pending = chrome.debugger.attach({ tabId }, "1.3").catch((error: unknown) => { attached.delete(tabId); throw error; });
      entry = { phase: "attached", pending, users: new Set() };
      attached.set(tabId, entry);
    }
    entry.users.add(this);
    await entry.pending;
  }
}

const EVAL_MS = 3_000;

// Waits `ms`, or rejects as soon as `signal` aborts (and drops the timer).
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
  });
}

// Settles with `promise`, or rejects as soon as `signal` aborts.
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

type Exception = { text?: string; exception?: { description?: string } };
const describe = (e: Exception) => e.exception?.description ?? e.text ?? "Script failed";

// chrome.userScripts, which Chrome hides until the user allows user scripts
// for this extension.
function userScripts(): typeof chrome.userScripts {
  try {
    if (typeof chrome.userScripts?.getScripts === "function") return chrome.userScripts;
  } catch { /* Chrome throws while the toggle is off. */ }
  throw new Error(`Chrome isn't letting Ardi run userscripts. Ask the user to open chrome://extensions/?id=${chrome.runtime.id} and turn on "Allow User Scripts" (on Chrome before 138, turn on Developer mode instead), then try again.`);
}

// Serves the bridge's relay requests for one native connection with a fresh
// controller.
export function connectBrowser(reply: (reply: BrowserReply) => void): BrowserLink {
  const control = new ChromeBrowserController();
  const requests = new Map<string, AbortController>();
  return {
    receive(event) {
      if (event.type === "browser_cancel") {
        requests.get(event.id)?.abort(new Error("Browser request canceled"));
        return;
      }
      const cancel = new AbortController();
      requests.set(event.id, cancel);
      void control.execute(event.request as BrowserRequest, cancel.signal).then(
        result => reply({ type: "browser_reply", id: event.id, result }),
        (error: unknown) => reply({ type: "browser_reply", id: event.id, error: error instanceof Error ? error.message : String(error) }),
      ).finally(() => requests.delete(event.id));
    },
    preparePrompt: () => control.preparePrompt(),
    cancel: () => control.cancel(),
    async dispose() {
      for (const cancel of requests.values()) cancel.abort();
      requests.clear();
      await control.dispose();
    },
  };
}
