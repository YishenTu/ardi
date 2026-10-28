import { mention, type TabMention } from "../mention";
import { tabChip } from "./dom";

// The message box: an editable line of plain text with tab chips inline.
// `value` is the message as pi gets it, each chip written as a mention.
// Editing it fires "input", including changes made through this class.
export class Composer {
  constructor(readonly el: HTMLElement) {
    // Emptied by hand, the box can keep a stray <br>; drop it so the
    // placeholder shows again.
    el.addEventListener("input", () => {
      if (!el.textContent) el.replaceChildren();
    });
  }

  get value(): string {
    return serialize(this.el);
  }

  // Replaces everything (chips too) with plain text, caret at the end.
  set value(text: string) {
    this.el.textContent = text;
    const selection = getSelection();
    selection?.selectAllChildren(this.el);
    selection?.collapseToEnd();
    this.changed();
  }

  // The text before the caret, up to the nearest chip.
  beforeCaret(): string {
    const caret = this.caret();
    return caret ? caret.node.data.slice(0, caret.offset) : "";
  }

  // Replaces the `replace` characters before the caret with a chip for the
  // tab, then a space, and puts the caret after it.
  insertTab(tab: TabMention, replace: number) {
    const caret = this.caret();
    if (!caret) return;
    const range = document.createRange();
    range.setStart(caret.node, Math.max(0, caret.offset - replace));
    range.setEnd(caret.node, caret.offset);
    range.deleteContents();
    const space = document.createTextNode(" ");
    range.insertNode(space);
    range.insertNode(chip(tab));
    getSelection()?.collapse(space, 1);
    this.changed();
  }

  focus() {
    this.el.focus();
  }

  private caret(): { node: Text; offset: number } | null {
    const selection = getSelection();
    if (!selection?.rangeCount || !selection.isCollapsed) return null;
    const { startContainer: node, startOffset: offset } = selection.getRangeAt(0);
    if (!this.el.contains(node)) return null;
    if (node instanceof Text) return { node, offset };
    // A caret between nodes (after a programmatic change) counts as the end
    // of the text before it.
    const before = node.childNodes[offset - 1];
    return before instanceof Text ? { node: before, offset: before.length } : null;
  }

  private changed() {
    this.el.dispatchEvent(new Event("input"));
  }
}

function chip(tab: TabMention): HTMLElement {
  const node = tabChip("span", tab);
  node.contentEditable = "false";
  node.dataset.title = tab.title;
  node.dataset.url = tab.url;
  return node;
}

// The box's text, with chips as mentions and line breaks as "\n".
function serialize(root: Node): string {
  let text = "";
  for (const node of root.childNodes) {
    if (node instanceof Text) text += node.data;
    else if (!(node instanceof HTMLElement)) continue;
    else if (node.dataset.url) text += mention({ title: node.dataset.title ?? "", url: node.dataset.url });
    else if (node.tagName === "BR") text += "\n";
    else text += (node.tagName === "DIV" && text ? "\n" : "") + serialize(node);
  }
  return text;
}
