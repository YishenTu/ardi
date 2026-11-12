import { describe, expect, test } from "bun:test";

import { chromeFake, type FakePort } from "../../support/chrome";
import { mentionableTabs } from "../../../src/background/tabs";
import { setTarget } from "../../../src/background/target";

const NATIVE_HOST = "com.ardi.test";

describe("mentionableTabs", () => {
  test("a target that doesn't narrow tabs allows every tab without starting a bridge", async () => {
    setTarget({ nativeHost: NATIVE_HOST });
    expect(await mentionableTabs()).toBeNull();
    expect(chromeFake.nativePorts).toEqual([]);
  });

  test("a target that narrows tabs asks a short-lived bridge for them", async () => {
    setTarget({ nativeHost: NATIVE_HOST, narrowsTabs: true });
    chromeFake.onConnectNative = (port: FakePort) => {
      port.onPost = () => queueMicrotask(() => port.receive({ type: "tabs", tabs: [{ title: "A", url: "https://a.test/" }] }));
    };
    expect(await mentionableTabs()).toEqual([{ title: "A", url: "https://a.test/" }]);
    const [port] = chromeFake.nativePorts;
    expect(port.sent).toEqual([{ type: "list_tabs" }]);
    expect(port.disconnected).toBe(true);
  });

  test("allows every tab when the bridge can't start", async () => {
    setTarget({ nativeHost: NATIVE_HOST, narrowsTabs: true });
    chromeFake.onConnectNative = (port) => queueMicrotask(() => port.close("Specified native messaging host not found."));
    expect(await mentionableTabs()).toBeNull();
  });
});
