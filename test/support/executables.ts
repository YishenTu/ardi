// Programs tests run: the fake pi, and shell scripts in the temp home.
import { chmodSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const FAKE_PI = resolve(import.meta.dirname, "../fixtures/fake-pi.ts");

// Writes an executable shell script `~/name` and returns its path.
export function script(name: string, body: string): string {
  const path = join(homedir(), name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}
