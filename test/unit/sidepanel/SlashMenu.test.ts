import { beforeEach, describe, expect, test } from "bun:test";

import { $, loadPanel } from "../../support/panel";
import { Composer } from "../../../src/sidepanel/Composer";
import { SlashMenu } from "../../../src/sidepanel/SlashMenu";

let input: Composer;
let list: HTMLElement;
let menu: SlashMenu;
let ran: string[];

beforeEach(() => {
  loadPanel();
  input = new Composer($("input"));
  list = $("slash");
  ran = [];
  menu = new SlashMenu(input, list, [
    { name: "new", description: "Start a new chat", run: () => ran.push("new") },
    { name: "compact", description: "Summarize this chat", run: () => ran.push("compact") },
  ]);
  menu.setCommands([{ name: "skill:news", description: "Today's news" }, { name: "skill:recipes" }]);
});

function type(text: string) {
  input.value = text;
  menu.update();
}

const press = (key: string) => menu.keydown(new KeyboardEvent("keydown", { key, cancelable: true }));
const shown = () => [...list.children].map((row) => (row.classList.contains("dropup-divider") ? "---" : row.querySelector(".dropup-name")!.textContent));
const selected = () => list.querySelector('[aria-selected="true"] .dropup-name')?.textContent;

describe("SlashMenu", () => {
  test("opens on a leading slash with Ardi's commands, then pi's after a divider", () => {
    type("/");
    expect(list.hidden).toBe(false);
    expect(shown()).toEqual(["/new", "/compact", "---", "/skill:news", "/skill:recipes"]);
    expect(selected()).toBe("/new");
  });

  test("filters as you type, and closes once there's a space or no match", () => {
    type("/rec");
    expect(shown()).toEqual(["/skill:recipes"]);
    type("/skill:news today");
    expect(list.hidden).toBe(true);
    type("/zzz");
    expect(list.hidden).toBe(true);
    type("hello /new");
    expect(list.hidden).toBe(true);
  });

  test("arrows move the selection and wrap around", () => {
    type("/");
    press("ArrowUp");
    expect(selected()).toBe("/skill:recipes");
    press("ArrowDown");
    expect(selected()).toBe("/new");
  });

  test("picking one of Ardi's commands runs it and clears the composer", () => {
    type("/comp");
    expect(press("Enter")).toBe(true);
    expect(ran).toEqual(["compact"]);
    expect(input.value).toBe("");
    expect(list.hidden).toBe(true);
  });

  test("picking a pi command puts it in the composer for the user to finish", () => {
    type("/news");
    press("Tab");
    expect(ran).toEqual([]);
    expect(input.value).toBe("/skill:news ");
  });

  test("leaves keys alone when closed, and Escape closes it", () => {
    type("hello");
    expect(press("Enter")).toBe(false);
    type("/");
    press("Escape");
    expect(list.hidden).toBe(true);
    expect(press("ArrowDown")).toBe(false);
  });
});
