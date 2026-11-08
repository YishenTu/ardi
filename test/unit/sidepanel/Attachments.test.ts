import { beforeEach, expect, test } from "bun:test";

import { $, loadPanel } from "../../support/panel";
import { waitFor } from "../../support/wait";
import { Attachments } from "../../../src/sidepanel/Attachments";

let attachments: Attachments;

beforeEach(() => {
  loadPanel();
  attachments = new Attachments($("attachments"), $("input"));
});

// A PNG whose bytes are "hi" (base64 "aGk=").
const png = (name = "shot.png") => new File([new Uint8Array([104, 105])], name, { type: "image/png" });

// jsdom has no ClipboardEvent or DragEvent data, so the files ride on a plain event.
function fire(target: EventTarget, type: string, key: "clipboardData" | "dataTransfer", files: File[]): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, key, { value: { files, types: files.length ? ["Files"] : ["text/plain"], dropEffect: "none" } });
  target.dispatchEvent(event);
  return event;
}

const thumbs = () => [...$("attachments").querySelectorAll("img")];

test("a pasted image shows as a thumbnail and goes with the message", async () => {
  expect(fire($("input"), "paste", "clipboardData", [png()]).defaultPrevented).toBe(true);
  await waitFor(() => expect(thumbs()[0].src).toBe("data:image/png;base64,aGk="));
  expect($("attachments").hidden).toBe(false);
  expect(await attachments.take()).toEqual([{ data: "aGk=", mimeType: "image/png" }]);
  expect($("attachments").hidden).toBe(true);
});

test("an image still loading when the message is sent goes with it, not with the next one", async () => {
  let finish!: () => void;
  const loaded = new Promise<void>((resolve) => (finish = resolve));
  const slow = png();
  const read = slow.arrayBuffer.bind(slow);
  slow.arrayBuffer = async () => { await loaded; return read(); };
  fire($("input"), "paste", "clipboardData", [slow]);
  const sent = attachments.take();
  finish();
  expect(await sent).toEqual([{ data: "aGk=", mimeType: "image/png" }]);
  expect($("attachments").children).toHaveLength(0);
  expect(await attachments.take()).toEqual([]);
});

test("pasting text alone is left to the composer", () => {
  expect(fire($("input"), "paste", "clipboardData", []).defaultPrevented).toBe(false);
});

test("images dropped on the panel attach; other files are left out", async () => {
  const drop = fire(document.body, "drop", "dataTransfer", [png(), new File(["x"], "notes.pdf", { type: "application/pdf" })]);
  // The panel must not navigate to a dropped file.
  expect(drop.defaultPrevented).toBe(true);
  await waitFor(() => expect(thumbs()).toHaveLength(1));
});

test("a removed image doesn't go with the message", async () => {
  fire($("input"), "paste", "clipboardData", [png("a.png"), png("b.png")]);
  await waitFor(() => expect(thumbs()).toHaveLength(2));
  $("attachments").querySelector<HTMLButtonElement>(".attachment-remove")!.click();
  expect(thumbs()).toHaveLength(1);
  expect(await attachments.take()).toHaveLength(1);
});

test("images handed back to the message box go before those already there, like their text", async () => {
  fire($("input"), "paste", "clipboardData", [png()]);
  await waitFor(() => expect(thumbs()).toHaveLength(1));
  attachments.restore([{ data: "QQ==", mimeType: "image/png" }]);
  expect(thumbs()[0].src).toBe("data:image/png;base64,QQ==");
  expect(await attachments.take()).toEqual([{ data: "QQ==", mimeType: "image/png" }, { data: "aGk=", mimeType: "image/png" }]);
});
