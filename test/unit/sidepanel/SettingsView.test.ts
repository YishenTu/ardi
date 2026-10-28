import { beforeEach, describe, expect, test } from "bun:test";

import { chromeFake } from "../../support/chrome";
import { $, loadPanel } from "../../support/panel";
import { waitFor } from "../../support/wait";
import type { SettingsRequest } from "../../../src/shared";
import { SettingsView } from "../../../src/sidepanel/SettingsView";

// The background's answers. `pending` holds get_settings until released.
let requests: SettingsRequest[];
let savedPath: string;
let release: () => void;

function background({ working = ["/opt/pi"], hold = false } = {}) {
  requests = [];
  const held = new Promise<void>((resolve) => (release = resolve));
  const check = (path: string) => {
    const command = path || "/installed/pi";
    return working.includes(command) ? { command, version: "1.4.0" } : { command, error: `Pi not found at ${command}` };
  };
  chromeFake.onSendMessage = async (req: SettingsRequest) => {
    requests.push(req);
    if (req.kind === "get_settings") {
      if (hold) await held;
      return { settings: { piPath: savedPath }, check: check(savedPath) };
    }
    const result = check(req.piPath);
    const saved = !result.error || !req.piPath;
    if (saved) savedPath = req.piPath;
    return { saved, check: result };
  };
}

let view: SettingsView;
const path = () => $<HTMLInputElement>("pi-path");
const message = () => $("pi-check");

function commit(value: string) {
  path().value = value;
  path().dispatchEvent(new Event("change"));
}

beforeEach(() => {
  loadPanel();
  savedPath = "";
  view = new SettingsView($("settings"));
});

describe("SettingsView", () => {
  test("opening shows the saved path and the version of the Pi it runs", async () => {
    savedPath = "/opt/pi";
    background();
    await view.open();
    expect(view.isOpen).toBe(true);
    expect(path().value).toBe("/opt/pi");
    expect($("pi-version").textContent).toBe("1.4.0");
    expect(message().textContent).toBe("");
  });

  test("with no path set, the installed Pi shows as the placeholder", async () => {
    background({ working: ["/installed/pi"] });
    await view.open();
    expect(path().placeholder).toBe("/installed/pi");
  });

  test("the field stays disabled until the saved path arrives, so typing can't be overwritten", async () => {
    savedPath = "/opt/pi";
    background({ hold: true });
    const opening = view.open();
    expect(path().disabled).toBe(true);
    release();
    await opening;
    expect(path().disabled).toBe(false);
  });

  test("the CLI path is folded under the Pi row, which opens and closes it", async () => {
    savedPath = "/opt/pi";
    background();
    await view.open();
    const toggle = $("pi-toggle");
    expect($("pi-path-row").hidden).toBe(true);
    toggle.click();
    expect($("pi-path-row").hidden).toBe(false);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(path());
    toggle.click();
    expect($("pi-path-row").hidden).toBe(true);
  });

  test("it opens by itself when Pi doesn't run, so the error shows", async () => {
    savedPath = "/typo/pi";
    background();
    await view.open();
    expect($("pi-path-row").hidden).toBe(false);
    expect(message().textContent).toContain("/typo/pi");
  });

  test("committing a working path saves it, trimmed", async () => {
    background();
    await view.open();
    commit("  /opt/pi ");
    await waitFor(() => expect(requests.at(-1)).toEqual({ kind: "set_pi_path", piPath: "/opt/pi" }));
    await waitFor(() => expect($("pi-version").textContent).toBe("1.4.0"));
    expect(path().value).toBe("/opt/pi");
    expect(savedPath).toBe("/opt/pi");
  });

  test("a path that doesn't run shows why, and isn't treated as saved", async () => {
    background();
    await view.open();
    commit("/typo/pi");
    await waitFor(() => expect(message().textContent).toBe("Pi not found at /typo/pi"));
    expect(message().dataset.state).toBe("error");
    // Committing it again checks again, since it was never saved.
    commit("/typo/pi");
    await waitFor(() => expect(requests.filter((r) => r.kind === "set_pi_path")).toHaveLength(2));
  });

  test("committing the saved path again does nothing", async () => {
    savedPath = "/opt/pi";
    background();
    await view.open();
    commit("/opt/pi");
    await Promise.resolve();
    expect(requests).toEqual([{ kind: "get_settings" }]);
  });
});
