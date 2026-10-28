import { expect, test } from "bun:test";

import { toModelInfo } from "../../../src/bridge/models";

test("a model without reasoning only offers thinking off", () => {
  expect(toModelInfo([{ provider: "p", id: "plain" }])[0].thinkingLevels).toEqual(["off"]);
});

test("a reasoning model gets the default levels", () => {
  expect(toModelInfo([{ provider: "p", id: "r", reasoning: true }])[0].thinkingLevels).toEqual(["off", "minimal", "low", "medium", "high"]);
});

test("thinkingLevelMap adds levels, removes ones mapped to null, and keeps pi's order", () => {
  const [model] = toModelInfo([{ provider: "p", id: "r", reasoning: true, thinkingLevelMap: { max: "max", minimal: null, xhigh: "xhigh", bogus: "x" } }]);
  expect(model.thinkingLevels).toEqual(["off", "low", "medium", "high", "xhigh", "max"]);
});
