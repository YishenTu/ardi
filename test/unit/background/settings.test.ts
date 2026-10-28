import { describe, expect, test } from "bun:test";

import { chromeFake, type FakePort } from "../../support/chrome";
import { NATIVE_HOST } from "../../../src/shared";
import { checkPi, loadSettings, setPiPath } from "../../../src/background/settings";

// A bridge that answers check_pi: paths in `working` run, others fail.
function bridgeThatChecks(working: string[]) {
  chromeFake.onConnectNative = (port: FakePort) => {
    port.onPost = (message) => {
      const command = message.piPath ?? "/installed/pi";
      queueMicrotask(() =>
        port.receive(working.includes(command) ? { type: "pi_check", command, version: "1.4.0" } : { type: "pi_check", command, error: `Pi not found at ${command}` }),
      );
    };
  };
}

describe("checkPi", () => {
  test("asks a short-lived bridge to check the path, then lets it go", async () => {
    bridgeThatChecks(["/opt/pi"]);
    expect(await checkPi("/opt/pi")).toEqual({ command: "/opt/pi", version: "1.4.0" });
    const [port] = chromeFake.nativePorts;
    expect(port.name).toBe(NATIVE_HOST);
    expect(port.sent).toEqual([{ type: "check_pi", piPath: "/opt/pi" }]);
    expect(port.disconnected).toBe(true);
  });

  test("an empty path checks the installed pi", async () => {
    bridgeThatChecks(["/installed/pi"]);
    expect(await checkPi("")).toEqual({ command: "/installed/pi", version: "1.4.0" });
    expect(chromeFake.nativePorts[0].sent).toEqual([{ type: "check_pi" }]);
  });

  test("reports why when the bridge can't start", async () => {
    chromeFake.onConnectNative = (port) => queueMicrotask(() => port.close("Specified native messaging host not found."));
    expect(await checkPi("/opt/pi")).toEqual({ command: "/opt/pi", error: "Specified native messaging host not found." });
  });
});

describe("setPiPath", () => {
  test("saves a path where pi runs", async () => {
    bridgeThatChecks(["/opt/pi"]);
    expect(await setPiPath("/opt/pi")).toEqual({ saved: true, check: { command: "/opt/pi", version: "1.4.0" } });
    expect(await loadSettings()).toEqual({ piPath: "/opt/pi" });
  });

  test("keeps the old path when the new one doesn't run", async () => {
    bridgeThatChecks(["/opt/pi"]);
    await setPiPath("/opt/pi");
    const result = await setPiPath("/typo/pi");
    expect(result.saved).toBe(false);
    expect(result.check.error).toContain("/typo/pi");
    expect(await loadSettings()).toEqual({ piPath: "/opt/pi" });
  });

  test("clearing the path always saves, even if the installed pi is broken", async () => {
    bridgeThatChecks(["/opt/pi"]);
    await setPiPath("/opt/pi");
    const result = await setPiPath("");
    expect(result.saved).toBe(true);
    expect(result.check.error).toBeDefined();
    expect(await loadSettings()).toEqual({ piPath: "" });
  });
});
