// checkPi runs the pi it's given, so these start real processes.
import { describe, expect, test } from "bun:test";

import { FAKE_PI, script } from "../../support/executables";
import { checkPi } from "../../../src/bridge/launch";

describe("checkPi", () => {
  test("reports the version of a working pi", async () => {
    expect(await checkPi(FAKE_PI)).toEqual({ command: FAKE_PI, version: "0.0.0-fake" });
  });

  test("reports why a pi that fails can't be used", async () => {
    const broken = script("broken-pi", 'echo "missing runtime" >&2; exit 1');
    expect(await checkPi(broken)).toEqual({ command: broken, error: "missing runtime" });
  });
});
