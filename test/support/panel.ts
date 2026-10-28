// Loads the side panel's real markup (without its scripts) into the test DOM,
// so view tests break if an id they rely on goes away.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const html = readFileSync(resolve(import.meta.dirname, "../../src/sidepanel/index.html"), "utf8");
const body = /<body>([\s\S]*)<\/body>/.exec(html)![1].replace(/<script[\s\S]*?<\/script>/g, "");

export function loadPanel(): void {
  document.body.innerHTML = body;
}

export function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`#${id} is not in index.html`);
  return node as T;
}
