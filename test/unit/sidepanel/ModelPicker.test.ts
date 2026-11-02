import { beforeEach, describe, expect, test } from "bun:test";

import type { ModelState, ThinkingLevel } from "../../../src/chat";
import { ModelPicker } from "../../../src/sidepanel/ModelPicker";
import { $, loadPanel } from "../../support/panel";

let picker: ModelPicker;
let picked: string[];

const STATE: ModelState = {
  models: [
    { provider: "anthropic", id: "opus", name: "Opus", thinkingLevels: ["off", "low", "high"] },
    { provider: "anthropic", id: "haiku", name: "Haiku", thinkingLevels: ["off"] },
    { provider: "openai", id: "gpt", name: "GPT", thinkingLevels: ["off", "medium"] },
  ],
  current: { provider: "anthropic", id: "opus" },
  thinkingLevel: "high",
};

beforeEach(() => {
  loadPanel();
  picked = [];
  picker = new ModelPicker($("options-toggle"), $("options"), $("options-tip"), {
    setModel: (provider, id) => picked.push(`${provider}/${id}`),
    setThinkingLevel: (level: ThinkingLevel) => picked.push(level),
  });
});

const button = (label: string) => [...$("options").querySelectorAll("button")].find((b) => b.textContent === label)!;
const checked = () => [...$("options").querySelectorAll('[aria-checked="true"]')].map((b) => b.textContent);

describe("ModelPicker", () => {
  test("one composer button opens a panel with the models by provider and the current model's effort levels", () => {
    expect($("options-toggle").hidden).toBe(true);
    picker.render(STATE);
    expect($("options-toggle").hidden).toBe(false);
    expect($("options-tip").textContent).toBe("Opus · High");
    expect([...$("options").querySelectorAll("h2")].map((h) => h.textContent)).toEqual(["Model", "anthropic", "openai", "Effort"]);
    expect([...$("options").querySelectorAll(".effort button")].map((b) => b.textContent)).toEqual(["Off", "Low", "High"]);
    expect(checked()).toEqual(["Opus", "High"]);
  });

  test("picking sends the change to pi; picking the current choice does nothing", () => {
    picker.render(STATE);
    button("GPT").click();
    button("Low").click();
    button("Opus").click();
    button("High").click();
    expect(picked).toEqual(["openai/gpt", "low"]);
  });

  test("a model without thinking shows no effort control", () => {
    picker.render({ ...STATE, current: { provider: "anthropic", id: "haiku" }, thinkingLevel: "off" });
    expect($("options").querySelector(".effort")).toBeNull();
    expect($("options-tip").textContent).toBe("Haiku");
  });
});
