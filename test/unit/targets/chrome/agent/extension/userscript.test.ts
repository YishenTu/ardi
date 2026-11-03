import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { pathToFileURL } from "node:url";
import { NODE } from "../../../../../support/executables";
import { parseUserscript, runsOn } from "../../../../../../src/targets/chrome/agent/extension/userscript";
import type { Userscript } from "../../../../../../src/targets/chrome/protocol";

const header = (...lines: string[]) => ["// ==UserScript==", ...lines.map(l => `// ${l}`), "// ==/UserScript==", ""].join("\n");

test("a Violentmonkey header becomes Chrome's registration, keeping the source as the code", () => {
  const source = header("@name Hide promos", "@match https://*.example.com/*", "@exclude-match https://example.com/admin/*", "@run-at document-start") + "document.body.dataset.ok = '1';\n";
  const { script, warnings } = parseUserscript(source, "promos.user.js");
  expect(script).toEqual({
    id: "Hide promos",
    matches: ["https://*.example.com/*"],
    excludeMatches: ["https://example.com/admin/*"],
    excludeGlobs: [],
    runAt: "document_start",
    world: "MAIN",
    allFrames: true,
    code: source,
  });
  expect(warnings).toEqual([]);
});

test("Ardia's defaults and keys map to the same behaviour in Chrome", () => {
  const { script, warnings } = parseUserscript(header("@name Isolated", "@match https://a.test/*", "@exclude *?print=1", "@inject-into content", "@noframes", "@grant GM_setValue") + "1;", "a.user.js");
  expect(script).toMatchObject({ matches: ["https://a.test/*"], excludeGlobs: ["*?print=1"], runAt: "document_end", world: "USER_SCRIPT", allFrames: false });
  expect(warnings.join("\n")).toContain("@grant");
});

// Runs a registered script's code on `url`. With @include, Chrome injects it on every http(s) page and the code decides.
function runAt(script: Userscript, url: string): boolean {
  expect(script.matches).toEqual(["http://*/*", "https://*/*"]);
  const page = { location: { href: url }, ran: false };
  runInNewContext(script.code.replace("RAN", "ran = true"), page);
  return page.ran;
}

test("@include alone runs only on the pages its globs cover, though Chrome needs broad matches to inject", () => {
  const { script, pages } = parseUserscript(header("@name News", "@include https://news.test/*") + "RAN;\n", "news.user.js");
  expect(script.includeGlobs).toBeUndefined();
  expect(runAt(script, "https://news.test/today")).toBe(true);
  expect(runAt(script, "https://bank.test/")).toBe(false);
  expect(runsOn(pages, "https://news.test/today")).toBe(true);
  expect(runsOn(pages, "https://bank.test/")).toBe(false);
});

test("@match and @include together run where either covers, like Violentmonkey and Chrome", () => {
  const { script } = parseUserscript(header("@name Both", "@match https://a.test/*", "@include https://b.test/*") + "RAN;\n", "both.user.js");
  expect(runAt(script, "https://a.test/x")).toBe(true);
  expect(runAt(script, "https://b.test/x")).toBe(true);
  expect(runAt(script, "https://c.test/x")).toBe(false);
});

test("globs follow Chrome: ? is zero or one character and a backslash escapes a wildcard", () => {
  const glob = (pattern: string, url: string) => runsOn(parseUserscript(header("@name G", "@match https://g.test/*", `@exclude ${pattern}`) + "1;", "g.user.js").pages, url);
  expect(glob("https://g.test/a?b", "https://g.test/ab")).toBe(false);
  expect(glob("https://g.test/a?b", "https://g.test/axb")).toBe(false);
  expect(glob("https://g.test/a?b", "https://g.test/axxb")).toBe(true);
  expect(glob("https://g.test/a\\*", "https://g.test/a*")).toBe(false);
  expect(glob("https://g.test/a\\*", "https://g.test/abc")).toBe(true);
});

// Pi runs on Node, whose type stripping Bun lacks, so this runs under Node.
test("a single-file TypeScript script loses its types and keeps its code", () => {
  const source = header("@name Typed", "@match https://a.test/*") + "const n: number = 1;\nconsole.log(n);\n";
  const module = pathToFileURL(resolve(import.meta.dirname, "../../../../../../src/targets/chrome/agent/extension/userscript.ts")).href;
  const run = spawnSync(NODE, ["--input-type=module", "-e", `import { parseUserscript } from ${JSON.stringify(module)}; console.log(parseUserscript(${JSON.stringify(source)}, "typed.user.ts").script.code)`], { encoding: "utf8" });
  expect(run.stderr.replace(/.*ExperimentalWarning.*\n?|.*--trace-warnings.*\n?/g, "")).toBe("");
  expect(run.stdout).not.toContain(": number");
  expect(run.stdout).toContain("console.log(n)");
  expect(run.stdout).toContain("@name Typed");
});

test("imports, a missing name or no pages are refused", () => {
  expect(() => parseUserscript(header("@name Split", "@match https://a.test/*") + "import { x } from './x';\n", "split.user.js")).toThrow("one file");
  expect(() => parseUserscript(header("@match https://a.test/*") + "1;", "nameless.user.js")).toThrow("@name");
  expect(() => parseUserscript(header("@name Nowhere") + "1;", "nowhere.user.js")).toThrow("@match");
  expect(() => parseUserscript("console.log(1)", "bare.js")).toThrow("==UserScript==");
});
