import type { BridgeEvent, BridgeRequest } from "../bridge/protocol";
import { joinParts, postInParts } from "../parts";
import { target } from "./target";

// Asks a short-lived bridge one question, apart from the bridge running pi,
// and lets it go. `answer` picks the reply out of the bridge's events;
// `failed` answers instead, with why, if the bridge closes first or doesn't
// answer in `timeoutMs` (an older bridge ignores requests it doesn't know).
export function askBridge<T>(request: BridgeRequest, answer: (event: BridgeEvent) => T | undefined, failed: (error: string) => T, timeoutMs = 10_000): Promise<T> {
  return new Promise((resolve) => {
    const port = chrome.runtime.connectNative(target().nativeHost);
    const finish = (result: T) => {
      clearTimeout(timer);
      resolve(result);
      port.disconnect();
    };
    const timer = setTimeout(() => finish(failed("The bridge didn't answer")), timeoutMs);
    port.onMessage.addListener(
      joinParts<BridgeEvent>((event) => {
        const result = answer(event);
        if (result !== undefined) finish(result);
      }),
    );
    port.onDisconnect.addListener(() => finish(failed(chrome.runtime.lastError?.message ?? "The bridge closed")));
    postInParts(port, request);
  });
}
