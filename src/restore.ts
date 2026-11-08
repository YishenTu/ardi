import type { ImageAttachment } from "./chat";

// Messages taken back to the message box (Stop, Edit, rejected or never
// answered), as one entry: texts joined, images together. Shared by the
// bridge and the background, which both hand messages back.
export function restoreOf(messages: { text: string; images?: ImageAttachment[] }[]): { text: string; images?: ImageAttachment[] } | undefined {
  const text = messages.map((message) => message.text.trim()).filter(Boolean).join("\n\n");
  const images = messages.flatMap((message) => message.images ?? []);
  if (!text && !images.length) return undefined;
  return images.length ? { text, images } : { text };
}
