import { beforeEach, expect, test } from "bun:test";

import { chromeFake } from "../../support/chrome";
import { askBridge } from "../../../src/background/ask-bridge";
import { setTarget } from "../../../src/background/target";

beforeEach(() => setTarget({ nativeHost: "com.ardi.test" }));

// An older bridge ignores requests it doesn't know and stays connected.
test("gives up on a bridge that never answers, and lets it go", async () => {
  const answer = await askBridge({ type: "list_tabs" }, () => undefined, (error) => error, 20);
  expect(answer).toBe("The bridge didn't answer");
  expect(chromeFake.nativePorts[0].disconnected).toBe(true);
});
