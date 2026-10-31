// Runs before every test file (bunfig.toml).
import { afterEach, mock } from "bun:test";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import { join } from "node:path";

import globalJsdom from "global-jsdom";

import { resetChrome } from "./support/chrome";

// The bridge writes to ~/.ardi and pi's sessions live under HOME, so tests
// get their own HOME and never touch the real one. Bun reads os.homedir()
// once at startup, so setting HOME isn't enough: homedir is replaced too.
const home = mkdtempSync(join(os.tmpdir(), "ardi-test-home-"));
process.env.HOME = home;
void mock.module("node:os", () => ({ ...os, default: { ...os, homedir: () => home }, homedir: () => home }));
delete process.env.ARDI_PI_BIN;

// A DOM for the side panel's views. jsdom, because DOMPurify (which keeps
// pages' HTML out of answers) doesn't sanitize correctly on lighter DOMs.
globalJsdom(undefined, { url: "http://localhost/sidepanel.html", pretendToBeVisual: true });
// Bun has its own Event and EventTarget, which global-jsdom leaves in place;
// jsdom's elements only accept jsdom's.
for (const name of ["Event", "EventTarget", "CustomEvent", "UIEvent", "KeyboardEvent", "MouseEvent", "FocusEvent", "InputEvent"]) {
  Object.assign(globalThis, { [name]: (window as any)[name] });
}
// jsdom doesn't lay out, so it has no scrolling.
Element.prototype.scrollIntoView = () => {};

// Every file gets the chrome.* fake (test/support/chrome.ts), fresh per test.
afterEach(resetChrome);

// Exercise Chrome integration in source tests; distribution tests cover both builds.
Object.assign(globalThis, { __ARDI_TARGET__: "chrome" });
