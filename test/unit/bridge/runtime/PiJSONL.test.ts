import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";

import { subscribePiJSONLLines } from "../../../../src/bridge/runtime/PiJSONL";

describe("subscribePiJSONLLines", () => {
  function lines(chunks: (string | Buffer)[]): string[] {
    const stream = new PassThrough();
    const out: string[] = [];
    subscribePiJSONLLines(stream, (line) => out.push(line));
    for (const chunk of chunks) stream.emit("data", chunk);
    stream.emit("end");
    return out;
  }

  test("splits on LF only, so U+2028 and U+2029 inside JSON strings survive", () => {
    expect(lines(['{"a":"x y z"}\n{"b":1}\n'])).toEqual(['{"a":"x y z"}', '{"b":1}']);
  });

  test("joins a line split across chunks, even mid-character", () => {
    const bytes = Buffer.from('{"t":"😀"}\n', "utf8");
    expect(lines([bytes.subarray(0, 7), bytes.subarray(7)])).toEqual(['{"t":"😀"}']);
  });
});
