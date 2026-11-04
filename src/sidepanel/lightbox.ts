// A sent image at full size, over the whole panel. A click anywhere or Esc
// closes it.
function lightbox(): HTMLElement {
  return document.getElementById("lightbox")!;
}

export function openLightbox(src: string) {
  const box = lightbox();
  box.querySelector("img")!.src = src;
  box.onclick = closeLightbox;
  box.hidden = false;
}

// Closes it if open; says whether it was.
export function closeLightbox(): boolean {
  const box = lightbox();
  if (box.hidden) return false;
  box.hidden = true;
  return true;
}
