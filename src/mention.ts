// A tab the user mentions with @. In the prompt pi gets it reads as a
// Markdown link with an @, `[@Title](url)`; the system prompt tells pi what
// that means, and the panel shows it as a chip.
export type TabMention = { title: string; url: string };

const MENTION = /\[@([^\]]*)\]\(([^)\s]+)\)/g;

export function mention(tab: TabMention): string {
  const title = tab.title.replace(/[[\]\n]/g, "");
  const url = tab.url.replace(/[()\s]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
  return `[@${title}](${url})`;
}

// The text split into plain runs and mentions, in order.
export function splitMentions(text: string): (string | TabMention)[] {
  const parts: (string | TabMention)[] = [];
  let at = 0;
  for (const match of text.matchAll(MENTION)) {
    if (match.index > at) parts.push(text.slice(at, match.index));
    parts.push({ title: match[1], url: match[2] });
    at = match.index + match[0].length;
  }
  if (at < text.length) parts.push(text.slice(at));
  return parts;
}

// The text with each mention as `@Title`, for places that show plain text.
export function plainMentions(text: string): string {
  return splitMentions(text)
    .map((part) => (typeof part === "string" ? part : `@${part.title}`))
    .join("");
}
