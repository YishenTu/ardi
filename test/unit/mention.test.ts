import { describe, expect, test } from "bun:test";

import { mention, plainMentions, splitMentions } from "../../src/mention";

describe("tab mentions", () => {
  test("a tab with brackets in its title and parentheses in its URL survives the round trip", () => {
    const tab = { title: "C++ [draft] (2024)", url: "https://en.wikipedia.org/wiki/C++_(programming_language)" };
    const text = `compare ${mention(tab)} with this`;
    const [before, found, after] = splitMentions(text);
    expect(before).toBe("compare ");
    expect(found).toEqual({ title: "C++ draft (2024)", url: "https://en.wikipedia.org/wiki/C++_%28programming_language%29" });
    expect(after).toBe(" with this");
    // The escaped URL still opens the same page.
    expect(decodeURI(new URL((found as { url: string }).url).pathname)).toBe("/wiki/C++_(programming_language)");
  });

  test("plain text shows each mention as @title, for chat titles", () => {
    const text = `${mention({ title: "Kyoto", url: "https://a.example/k" })} vs ${mention({ title: "Nara", url: "https://a.example/n" })}`;
    expect(plainMentions(text)).toBe("@Kyoto vs @Nara");
  });

  test("ordinary Markdown links aren't mentions", () => {
    expect(splitMentions("see [docs](https://example.com)")).toEqual(["see [docs](https://example.com)"]);
  });
});
