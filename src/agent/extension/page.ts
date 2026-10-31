export const MAX_CHARS = 20_000;

// The page's visible text, with a marker where each content image sits.
// Marked images get a `data-ardi-image` number so view_image can find them
// again. The markers are text nodes added for the one innerText read and
// removed in the same task, so the page never paints them.
export const READ_PAGE = `(() => {
  if (!document.body) return "";
  for (const img of document.querySelectorAll("img[data-ardi-image]")) delete img.dataset.ardiImage;
  const marks = [];
  for (const img of document.images) {
    const box = img.getBoundingClientRect();
    if (!img.naturalWidth || box.width < 150 || box.height < 100 || !img.checkVisibility()) continue;
    const n = marks.length + 1;
    img.dataset.ardiImage = String(n);
    const alt = img.alt.trim().slice(0, 80);
    const mark = document.createTextNode(" [image " + n + ": " + img.naturalWidth + "×" + img.naturalHeight + (alt ? ', "' + alt + '"' : "") + "] ");
    (img.parentElement?.tagName === "PICTURE" ? img.parentElement : img).before(mark);
    marks.push(mark);
  }
  const text = document.body.innerText;
  for (const mark of marks) mark.remove();
  return text;
})()`;

// Where image n is on the page, in page coordinates, and the scale that
// captures it near its own resolution (at most 2x, and 2000 px on a side).
export const locateImage = (n: number) => `(() => {
  const img = document.querySelector('img[data-ardi-image="${n}"]');
  if (!img) return null;
  const box = img.getBoundingClientRect();
  const scale = Math.max(0.1, Math.min(2, img.naturalWidth / box.width, 2000 / Math.max(box.width, box.height)));
  const inView = box.top >= 0 && box.bottom <= innerHeight && box.left >= 0 && box.right <= innerWidth;
  return { x: box.left + scrollX, y: box.top + scrollY, width: box.width, height: box.height, scale, inView, src: img.currentSrc };
})()`;

export const text = (value: string, details?: unknown) => ({ content: [{ type: "text" as const, text: value }], details });

export function truncate(value: string, max = MAX_CHARS): string {
  return value.length <= max ? value : `${value.slice(0, max)}\n\n[Output truncated: ${value.length} chars, showing the first ${max}.]`;
}

// Fetches an image the way its page would, with the page as the referer
// (many image hosts refuse requests without one). No cookies, so an image
// only the signed-in user can load fails; the error says what to do.
export async function fetchImage(src: string, page: string, signal?: AbortSignal): Promise<{ bytes: Buffer; mimeType: string }> {
  const failed = (why: string) => new Error(`Couldn't load the image (${why}). Ask the user to scroll it into view, then call view_image again.`);
  const response = await fetch(src, { headers: { Referer: page }, signal }).catch((error: Error) => {
    throw failed(error.message);
  });
  const mimeType = response.headers.get("content-type")?.split(";")[0] ?? "";
  if (!response.ok) throw failed(`HTTP ${response.status}`);
  if (!mimeType.startsWith("image/")) throw failed(`got ${mimeType || "no content type"}`);
  return { bytes: Buffer.from(await response.arrayBuffer()), mimeType };
}
