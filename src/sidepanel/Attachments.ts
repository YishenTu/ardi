import type { ImageAttachment } from "../chat";
import { el, imageUrl } from "./dom";

// Image types the models pi talks to accept.
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

const REMOVE_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" /></svg>';

// `image` is still being read until it resolves; the tile shows it then.
type Item = { image: Promise<ImageAttachment>; tile: HTMLElement };

// Images pasted into the message box or dropped anywhere on the panel, shown
// as thumbnails in `tray` (inside the composer's field) until the message
// is sent. Other files are left out for now.
export class Attachments {
  private items: Item[] = [];
  // dragenter/dragleave fire for every child crossed; count them to know
  // when the drag has really left the panel.
  private drags = 0;
  private readonly field: HTMLElement;

  constructor(private readonly tray: HTMLElement, input: HTMLElement) {
    this.field = tray.closest<HTMLElement>(".field") ?? tray;
    input.addEventListener("paste", (e) => {
      const files = imagesIn(e.clipboardData?.files);
      if (!files.length) return;
      e.preventDefault();
      this.add(files);
    });
    document.addEventListener("dragenter", (e) => {
      if (!hasFiles(e)) return;
      this.drags++;
      this.field.classList.add("dropping");
    });
    document.addEventListener("dragleave", (e) => {
      if (hasFiles(e) && --this.drags <= 0) this.endDrag();
    });
    document.addEventListener("dragover", (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer!.dropEffect = "copy";
    });
    // Always taken, so a dropped file never replaces the panel.
    document.addEventListener("drop", (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      this.endDrag();
      this.add(imagesIn(e.dataTransfer!.files));
    });
  }

  add(files: File[]) {
    for (const file of files) {
      const tile = el("div", "attachment");
      const img = tile.appendChild(el("img"));
      img.alt = "";
      const remove = tile.appendChild(el("button", "attachment-remove"));
      remove.type = "button";
      remove.title = "Remove";
      remove.setAttribute("aria-label", "Remove image");
      remove.innerHTML = REMOVE_ICON;
      const item: Item = { image: read(file), tile };
      remove.addEventListener("click", () => this.remove(item));
      // An image that can't be read just leaves the tray.
      item.image.then((image) => (img.src = imageUrl(image)), () => this.remove(item));
      this.items.push(item);
      this.tray.append(tile);
    }
    this.tray.hidden = !this.items.length;
  }

  // Empties the tray at once and returns its images for the message being
  // sent, waiting for any still being read.
  take(): Promise<ImageAttachment[]> {
    const taken = this.items;
    this.items = [];
    this.tray.replaceChildren();
    this.tray.hidden = true;
    return Promise.allSettled(taken.map((item) => item.image)).then((results) =>
      results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : [])),
    );
  }

  private remove(item: Item) {
    this.items = this.items.filter((other) => other !== item);
    item.tile.remove();
    this.tray.hidden = !this.items.length;
  }

  private endDrag() {
    this.drags = 0;
    this.field.classList.remove("dropping");
  }
}

function hasFiles(e: DragEvent): boolean {
  return e.dataTransfer?.types.includes("Files") ?? false;
}

function imagesIn(files: FileList | File[] | undefined): File[] {
  return Array.from(files ?? []).filter((file) => IMAGE_TYPES.has(file.type));
}

// The file as pi takes an image: base64.
async function read(file: File): Promise<ImageAttachment> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  // In slices: spreading a whole large image overflows the call stack.
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { data: btoa(binary), mimeType: file.type };
}
