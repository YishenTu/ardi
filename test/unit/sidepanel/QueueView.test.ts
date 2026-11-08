import { beforeEach, expect, test } from "bun:test";

import { $, loadPanel } from "../../support/panel";
import { QueueView } from "../../../src/sidepanel/QueueView";

let tray: HTMLElement;
let view: QueueView;
let asked: string[];

beforeEach(() => {
  loadPanel();
  tray = $("queue");
  asked = [];
  view = new QueueView(tray, ({ action, index, text }) => asked.push(`${action} ${index} ${text}`));
});

const rows = () => [...tray.querySelectorAll<HTMLElement>(".queued")];

test("shows each waiting message on a row, tab mentions as @title, steering ones marked", () => {
  view.render([{ text: "now", steer: true }, { text: "summarize [@Kyoto](https://example.com/kyoto)", steer: false }]);
  expect(tray.hidden).toBe(false);
  expect(rows().map((row) => row.querySelector(".queued-text")!.textContent)).toEqual(["now", "summarize @Kyoto"]);
  expect(rows().map((row) => row.querySelector(".queued-when, .queued-steer")!.textContent)).toEqual(["Steering", "Steer"]);
});

test("Steer, Edit and remove name the message by its place and text", () => {
  view.render([{ text: "a", steer: true }, { text: "b", steer: false }]);
  rows()[1].querySelector<HTMLButtonElement>(".queued-steer")!.click();
  rows()[0].querySelector<HTMLButtonElement>(".queued-edit")!.click();
  rows()[0].querySelector<HTMLButtonElement>(".queued-remove")!.click();
  expect(asked).toEqual(["steer 1 b", "edit 0 a", "remove 0 a"]);
});

test("hides when nothing is waiting", () => {
  view.render([{ text: "a", steer: false }]);
  view.render([]);
  expect(tray.hidden).toBe(true);
  expect(rows()).toEqual([]);
});
