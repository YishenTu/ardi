// Reads a userscript file the way Ardia's `ardia scripts` does (a
// Violentmonkey `==UserScript==` header) and turns it into Chrome's
// chrome.userScripts registration, so one script works in both.

// A namespace import: Bun, which runs the tests, has no stripTypeScriptTypes.
import * as nodeModule from "node:module";
import type { Userscript } from "../../protocol";

const RUN_AT = { "document-start": "document_start", "document-end": "document_end", "document-idle": "document_idle" } as const;
const IGNORED = new Set(["@grant", "@require", "@resource"]);

// Which pages a script runs on: an @match covers it, and no @exclude-match
// or @exclude does.
export type Pages = { matches: string[]; excludeMatches: string[]; excludes: string[] };

export function parseUserscript(source: string, file: string): { script: Userscript; pages: Pages; warnings: string[] } {
  const block = /^\/\/\s*==UserScript==\s*$([\s\S]*?)^\/\/\s*==\/UserScript==\s*$/m.exec(source);
  if (!block) throw new Error(`${file} has no // ==UserScript== header`);
  const keys = new Map<string, string[]>();
  for (const line of block[1].split("\n")) {
    const entry = /^\/\/\s*(@[\w-]+)(?:\s+(.*?))?\s*$/.exec(line.trim());
    if (entry) keys.set(entry[1], [...(keys.get(entry[1]) ?? []), entry[2] ?? ""]);
  }
  const one = (key: string) => keys.get(key)?.at(-1);
  const all = (key: string) => keys.get(key)?.filter(Boolean) ?? [];

  const name = one("@name");
  if (!name) throw new Error(`${file} needs an @name`);
  const code = file.endsWith(".ts") ? nodeModule.stripTypeScriptTypes(source) : source;
  // There's no bundler on the user's machine: a script is one file.
  if (/^\s*(import|export)\b/m.test(code)) throw new Error(`${file} imports or exports: a userscript in Chrome must be one file`);

  // A glob covers different pages than the same text as a match pattern,
  // and Chrome can't narrow a script by globs, so ask for @match instead.
  if (keys.has("@include")) throw new Error(`${file} uses @include, which Chrome can't limit a script to; write its pages as @match patterns (scheme://host/path, * as a wildcard)`);
  if (!all("@match").length) throw new Error(`${file} needs an @match saying which pages it runs on`);
  const runAt = RUN_AT[(one("@run-at") ?? "document-end") as keyof typeof RUN_AT];
  if (!runAt) throw new Error(`${file}: @run-at must be document-start, document-end or document-idle`);

  const pages: Pages = { matches: all("@match"), excludeMatches: all("@exclude-match"), excludes: all("@exclude") };
  // Every filter is sent, empty or not: reinstalling replaces them all.
  const script: Userscript = {
    id: name,
    matches: pages.matches,
    excludeMatches: pages.excludeMatches,
    excludeGlobs: pages.excludes,
    runAt,
    world: one("@inject-into") === "content" ? "USER_SCRIPT" : "MAIN",
    allFrames: !keys.has("@noframes"),
    code,
  };
  const warnings = [...keys.keys()].filter(key => IGNORED.has(key)).map(key => `${key} is ignored: there are no GM_* APIs, @require or @resource in Chrome either`);
  return { script, pages, warnings };
}

export function runsOn(pages: Pages, url: string): boolean {
  // Match patterns ignore the fragment; globs see the whole URL.
  const page = url.replace(/#.*$/, "");
  const any = (patterns: string[], toRegExp: (p: string) => RegExp, target: string) => patterns.some(p => toRegExp(p).test(target));
  return any(pages.matches, matchPattern, page)
    && !any(pages.excludeMatches, matchPattern, page)
    && !any(pages.excludes, glob, url);
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// A Chrome match pattern: scheme://host/path, `*` as a wildcard.
function matchPattern(pattern: string): RegExp {
  if (pattern === "<all_urls>") return /^(https?|file|ftp):/;
  const parts = /^(\*|[a-z]+):\/\/([^/]*)(\/.*)$/.exec(pattern);
  if (!parts) return /$^/;
  const [, scheme, host, path] = parts;
  const hostPart = host === "*" ? "[^/]*" : host.startsWith("*.") ? `([^/]*\\.)?${escape(host.slice(2))}` : escape(host);
  return new RegExp(`^${scheme === "*" ? "https?" : escape(scheme)}://${hostPart}(:\\d+)?${path.split("*").map(escape).join(".*")}$`);
}

// An @exclude glob over the whole URL, as Chrome reads it: `*` any
// run, `?` zero or one character, `\` escapes the next one.
function glob(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\" && i + 1 < pattern.length) out += escape(pattern[++i]);
    else out += c === "*" ? ".*" : c === "?" ? ".?" : escape(c);
  }
  return new RegExp(`^${out}$`);
}
