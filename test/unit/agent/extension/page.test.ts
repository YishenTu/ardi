import { afterEach, expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { READ_PAGE } from "../../../../src/agent/extension/page";

afterEach(() => { document.body.innerHTML = ""; Reflect.deleteProperty(document.body, "innerText"); });

test("the script sent to the browser reads visible text with image markers and removes temporary text nodes", () => {
  document.body.innerHTML = '<h1>Fixture heading</h1><img alt="Blue square">';
  // jsdom has no layout; provide the rendered dimensions/text a browser supplies.
  Object.defineProperty(document.body, "innerText", { configurable: true, get() { return this.textContent; } });
  const img = document.images[0];
  Object.defineProperties(img, { naturalWidth: { value: 200 }, naturalHeight: { value: 200 } });
  img.getBoundingClientRect = () => ({ width: 200, height: 200 }) as DOMRect;
  img.checkVisibility = () => true;
  const read = runInNewContext(READ_PAGE, { document });
  expect(read).toContain('Fixture heading');
  expect(read).toContain('[image 1: 200×200, "Blue square"]');
  expect(document.body.textContent).toBe('Fixture heading');
  expect(img.dataset.ardiImage).toBe('1');
});
