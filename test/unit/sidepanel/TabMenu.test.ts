import { beforeEach, describe, expect, test } from "bun:test";

import { chromeFake } from "../../support/chrome";
import { $, loadPanel } from "../../support/panel";
import { Composer } from "../../../src/sidepanel/Composer";
import { TabMenu } from "../../../src/sidepanel/TabMenu";

let composer: Composer;
let list: HTMLElement;
let menu: TabMenu;

beforeEach(() => {
  loadPanel();
  composer = new Composer($("input"));
  list = $("tab-menu");
  menu = new TabMenu(composer, list);
  chromeFake.tabs = [
    { title: "Hacker News", url: "https://news.ycombinator.com/", lastAccessed: 3 },
    { title: "Extensions", url: "chrome://extensions/", lastAccessed: 9 },
    { title: "Bun docs", url: "https://bun.sh/docs", lastAccessed: 5 },
  ];
});

// Types into the composer with the caret at the end.
async function type(text: string) {
  composer.value = text;
  await menu.update();
}

const press = (key: string) => menu.keydown(new KeyboardEvent("keydown", { key, cancelable: true }));
const shown = () => [...list.querySelectorAll(".dropup-name")].map((row) => row.textContent);

describe("TabMenu", () => {
  test("@ lists open web pages, most recent first, filtered by title or address", async () => {
    await type("@");
    expect(list.hidden).toBe(false);
    expect(shown()).toEqual(["Bun docs", "Hacker News"]);
    await type("compare @ycomb");
    expect(shown()).toEqual(["Hacker News"]);
  });

  test("only an @ that starts a word opens it, and a space closes it", async () => {
    await type("me@news");
    expect(list.hidden).toBe(true);
    await type("@news ");
    expect(list.hidden).toBe(true);
  });

  test("picking a tab puts a chip where the @ was, sent as a mention pi can read", async () => {
    await type("sum up @hack");
    expect(press("Enter")).toBe(true);
    expect(list.hidden).toBe(true);
    expect($("input").querySelector(".tab-chip")!.textContent).toBe("Hacker News");
    expect(composer.value).toBe("sum up [@Hacker News](https://news.ycombinator.com/) ");
  });

  test("Escape closes it and leaves the text", async () => {
    await type("@bun");
    press("Escape");
    expect(list.hidden).toBe(true);
    expect(composer.value).toBe("@bun");
  });
});
