import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { NODE } from "../../../../../support/executables";
import { parseUserscript, runsOn } from "../../../../../../src/targets/chrome/agent/extension/userscript";

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

// A glob covers different pages than the same text as a match pattern (the
// apex host, other ports, fragments), and Chrome can't narrow by globs, so
// Chrome asks for @match rather than guessing.
test("@include is refused with a pointer to @match, so a script never runs more widely than it says", () => {
  for (const include of ["https://*.example.com/*", "https://example.com/*", "http*://news.test/*"]) {
    expect(() => parseUserscript(header("@name Inc", `@include ${include}`) + "1;", "inc.user.js")).toThrow("@match");
    expect(() => parseUserscript(header("@name Both", "@match https://a.test/*", `@include ${include}`) + "1;", "both.user.js")).toThrow("@match");
  }
});

test("@match ignores the URL's fragment, as Chrome does", () => {
  const { script } = parseUserscript(header("@name Page", "@match https://a.test/page") + "1;", "page.user.js");
  expect(runsOn(script, "https://a.test/page#section")).toBe(true);
});

test("globs follow Chrome: ? is zero or one character and a backslash escapes a wildcard", () => {
  const glob = (pattern: string, url: string) => runsOn(parseUserscript(header("@name G", "@match https://g.test/*", `@exclude ${pattern}`) + "1;", "g.user.js").script, url);
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
  const run = spawnSync(NODE, ["--input-type=module", "-e", `import { parseUserscript } from ${JSON.stringify(module)}; console.log(parseUserscript(${JSON.stringify(source)}, "typed.user.ts").script.code)`], { encoding: "utf8", timeout: 30_000 });
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
