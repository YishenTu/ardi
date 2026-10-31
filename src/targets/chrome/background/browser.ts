import type { BrowserReply } from "../../../bridge/protocol";
import type { BrowserLink } from "../../../background/target";
import type { BrowserRequest, BrowserTab, TabSelector } from "../protocol";

// One controller per native connection. All targets belong to this extension's
// browser; no browser port, process discovery or external profile is involved.
const METHODS = new Set([
  "Runtime.evaluate", "Page.captureScreenshot", "Page.navigate", "Page.reload",
  "Input.insertText", "Input.dispatchKeyEvent", "Input.dispatchMouseEvent", "Input.dispatchTouchEvent",
  "DOM.getDocument", "DOM.querySelector", "DOM.querySelectorAll", "DOM.getBoxModel", "DOM.focus", "DOM.scrollIntoViewIfNeeded",
  "Accessibility.getFullAXTree",
]);
const webPage = (url: string) => /^(https?:\/\/|about:blank$|data:|blob:)/.test(url);

export class ChromeBrowserController {
  private closed = false;
  private readonly attaching = new Map<number, Promise<void>>();
  private cancellation = new AbortController();
  private cancellationEpoch = 0;
  private readonly onDetach = (source: chrome.debugger.Debuggee, reason: string) => {
    if (source.tabId === undefined) return;
    this.attaching.delete(source.tabId);
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
        let tab = await chrome.tabs.create({ url: request.url, active: request.background === false });
        const deadline = Date.now() + 20_000;
        while (tab.status !== "complete") {
          this.checkOpen(signal);
          if (Date.now() >= deadline) throw new Error(`Tab ${tab.id} is still loading; call read_tab with its id when ready`);
          await new Promise(resolve => setTimeout(resolve, 100));
          tab = await chrome.tabs.get(tab.id!);
        }
        return this.info(tab, (await this.current())?.id);
      }
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
    await Promise.all([...this.attaching].map(async ([tabId, pending]) => {
      try { await pending; await chrome.debugger.detach({ tabId }); } catch { /* Already detached/closed. */ }
    }));
    this.attaching.clear();
  }

  private checkOpen(signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (this.closed) throw new Error("Browser connection disconnected");
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
    let pending = this.attaching.get(tabId);
    if (!pending) {
      pending = chrome.debugger.attach({ tabId }, "1.3").catch((error: unknown) => { this.attaching.delete(tabId); throw error; });
      this.attaching.set(tabId, pending);
    }
    await pending;
  }
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
