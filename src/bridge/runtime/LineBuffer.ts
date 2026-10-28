// Adapted from Claudian (src/utils/LineBuffer.ts), without its size limit.
/** Retains incomplete lines without repeatedly joining or scanning their prefixes. */
export class LineBuffer {
  private fragments: string[] = [];
  private length = 0;

  get bufferedLength(): number { return this.length; }

  push(text: string, onLine: (line: string) => void): void {
    let start = 0;
    for (;;) {
      const end = text.indexOf('\n', start);
      const part = text.slice(start, end < 0 ? undefined : end);
      this.length += part.length;
      if (part) this.fragments.push(part);
      if (end < 0) return;
      onLine(this.take());
      start = end + 1;
    }
  }

  take(): string {
    const line = this.fragments.join('');
    this.fragments = [];
    this.length = 0;
    return line.endsWith('\r') ? line.slice(0, -1) : line;
  }
}
