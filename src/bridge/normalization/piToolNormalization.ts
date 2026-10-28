// Adapted from Claudian (src/providers/pi/normalization/piToolNormalization.ts).
// Kept: text extraction, codemode result header. Result `details` pass
// through untouched; the panel's ToolCard reads them.
// Dropped: Claudian tool renaming, images, fallbacks for other field names.

export function extractPiToolTextContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(extractPiToolTextContent).filter(Boolean).join("\n");
  if (!isPlainObject(value)) return "";
  if (typeof value.text === "string") return value.text;
  if (typeof value.content === "string") return value.content;
  if (Array.isArray(value.content)) return extractPiToolTextContent(value.content);
  return "";
}

/** The first content part of a codemode result; Pi's own renderer drops it too. */
const CODEMODE_RESULT_HEADER = /^Script (?:completed|failed)\nWall time [\d.]+ seconds\nOutput:\n$/;

/** Result text for display, given a result object or its content parts. */
export function extractPiToolResultText(toolName: string, value: unknown): string {
  const parts = Array.isArray(value) ? value : isPlainObject(value) && Array.isArray(value.content) ? value.content : null;
  const first: unknown = parts?.[0];
  if (parts && toolName === "codemode" && isPlainObject(first) && typeof first.text === "string" && CODEMODE_RESULT_HEADER.test(first.text)) {
    return extractPiToolTextContent(parts.slice(1));
  }
  return extractPiToolTextContent(value);
}

export function normalizePiToolInput(value: unknown): Record<string, unknown> {
  return isPlainObject(value) ? { ...value } : {};
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function getRecord(value: unknown): Record<string, unknown> | null {
  return isPlainObject(value) ? value : null;
}

export function getString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
