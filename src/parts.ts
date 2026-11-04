// Chrome caps each message: 1 MB from a native host, and 64 MiB over an
// extension port or to a native host. Chats with images go past both, so a
// big message travels as consecutive `part`s of its JSON, and `joinParts`
// puts them back together. Parts never interleave: each message's parts
// are posted in one go.
export type Part = { type: "part"; data: string; last: boolean };

// For the panel's port and the native port's extension side. A UTF-16 code
// unit is at most 3 UTF-8 bytes, so parts this long stay well under 64 MiB.
export const PORT_PART_CHARS = 8 * 1024 * 1024;

// What to post for `message`: the message itself if it fits, else its parts.
export function toParts(message: unknown, maxChars: number): unknown[] {
  const json = JSON.stringify(message);
  if (json.length <= maxChars) return [message];
  const parts: Part[] = [];
  for (let start = 0; start < json.length; ) {
    let end = Math.min(start + maxChars, json.length);
    // Keep a surrogate pair (an emoji, say) in one part.
    if (end < json.length && isHighSurrogate(json.charCodeAt(end - 1))) end--;
    parts.push({ type: "part", data: json.slice(start, end), last: end === json.length });
    start = end;
  }
  return parts;
}

export function postInParts(port: { postMessage(message: unknown): void }, message: unknown): void {
  for (const posted of toParts(message, PORT_PART_CHARS)) port.postMessage(posted);
}

// Wraps a message listener to accept parts.
export function joinParts<T>(listener: (message: T) => void): (message: T | Part) => void {
  let pending = "";
  return (message) => {
    if (!isPart(message)) return listener(message);
    pending += message.data;
    if (!message.last) return;
    const json = pending;
    pending = "";
    listener(JSON.parse(json) as T);
  };
}

function isPart(message: unknown): message is Part {
  return typeof message === "object" && message !== null && (message as Part).type === "part";
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}
