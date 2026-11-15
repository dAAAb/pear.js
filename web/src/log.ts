// The page's log: what it did and found, in English, for a person to copy into a report. It never holds a key:
// nothing that knows the key writes here, and a text is put through `redact` first where a service's own words
// are shown. An address of the model service is written without its host (model.ts, describeUrl).

/** How many lines the log keeps. */
export const LOG_LINES = 2000;
/** The first lines of the log are never dropped: the page's build, the browser and how the page was opened. */
export const LOG_HEAD_LINES = 3;
/** What stands where older lines were dropped. */
export const LOG_DROPPED = "          (older lines were dropped here)";

export class PageLog {
  private readonly lines: string[] = [];
  private readonly startedAt = performance.now();

  constructor(private readonly output: HTMLTextAreaElement) {}

  /** Adds a line, stamped with the seconds since the page loaded. */
  add(message: string): void {
    const seconds = ((performance.now() - this.startedAt) / 1000).toFixed(2).padStart(8, " ");
    this.lines.push(`${seconds}  ${message}`);
    // a log that is never copied should not grow without bound: the oldest lines after the head go, and one
    // line says so
    if (this.lines.length > LOG_LINES) {
      this.lines.splice(LOG_HEAD_LINES, this.lines.length - LOG_LINES + 1, LOG_DROPPED);
    }
    this.output.value = this.text;
    this.output.scrollTop = this.output.scrollHeight;
  }

  get text(): string {
    return this.lines.join("\n");
  }

  /** Copies the log to the clipboard and returns whether it worked. */
  async copy(): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(this.text);
      return true;
    } catch {
      // no clipboard for this page (not served securely, or not allowed): the old way
      this.output.focus();
      this.output.select();
      try {
        return document.execCommand("copy");
      } catch {
        return false;
      }
    }
  }
}

/** Returns ``text`` without ``secret``, wherever it occurs: a service may repeat a key in its refusal. */
export function redact(text: string, secret: string): string {
  const trimmed = secret.trim();

  return trimmed === "" ? text : text.split(trimmed).join("<key>");
}
