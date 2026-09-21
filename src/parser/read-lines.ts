/**
 * Shared streaming JSON and line-reading helpers for source adapters.
 * Detection can stop after the first value without reading the whole file.
 */

import { open } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

type Expectation =
  | "value" | "object-value" | "array-first" | "key-first"
  | "key" | "colon" | "array-end" | "object-end";
type NumberState =
  | "sign" | "zero" | "integer" | "dot" | "fraction"
  | "exponent" | "exponent-sign" | "exponent-digits";

class JsonRecordError extends SyntaxError {}

/** Validate prefixes incrementally so only genuinely incomplete tails are ignored. */
class JsonPrefix {
  private stack: Expectation[] = ["value"];
  private token: "string" | "number" | "literal" | undefined;
  private key = false;
  private escaped = false;
  private unicode = 0;
  private literal = "";
  private number: NumberState = "integer";
  done = false;

  constructor(private readonly fail: () => never) {}

  private finish(): void {
    this.token = undefined;
    if (this.key) {
      this.key = false;
      this.stack[this.stack.length - 1] = "colon";
    } else if (this.stack.length === 1) {
      this.done = true;
    } else {
      const expected = this.stack.at(-1);
      this.stack[this.stack.length - 1] =
        expected === "value" || expected === "array-first" ? "array-end" : "object-end";
    }
  }

  private numberComplete(): boolean {
    return ["zero", "integer", "fraction", "exponent-digits"].includes(this.number);
  }

  /** False means a number ended immediately before this character. */
  push(char: string): boolean {
    if (this.token === "string") {
      if (this.unicode) {
        if (!/^[0-9a-fA-F]$/.test(char)) this.fail();
        this.unicode--;
      } else if (this.escaped) {
        this.escaped = false;
        if (char === "u") this.unicode = 4;
        else if (!'"\\/bfnrt'.includes(char)) this.fail();
      } else if (char === "\\") this.escaped = true;
      else if (char === '"') this.finish();
      else if (char.charCodeAt(0) < 32) this.fail();
      return true;
    }
    if (this.token === "literal") {
      if (char !== this.literal[0]) this.fail();
      this.literal = this.literal.slice(1);
      if (!this.literal) this.finish();
      return true;
    }
    if (this.token === "number") {
      const digit = char >= "0" && char <= "9";
      switch (this.number) {
        case "sign":
          if (!digit) this.fail();
          this.number = char === "0" ? "zero" : "integer";
          return true;
        case "zero":
        case "integer":
          if (digit) {
            if (this.number === "zero") this.fail();
            return true;
          }
          if (char === ".") {
            this.number = "dot";
            return true;
          }
          break;
        case "dot":
          if (!digit) this.fail();
          this.number = "fraction";
          return true;
        case "fraction":
        case "exponent-digits":
          if (digit) return true;
          break;
        case "exponent":
          if (char === "+" || char === "-") {
            this.number = "exponent-sign";
            return true;
          }
          if (!digit) this.fail();
          this.number = "exponent-digits";
          return true;
        case "exponent-sign":
          if (!digit) this.fail();
          this.number = "exponent-digits";
          return true;
      }
      if ((char === "e" || char === "E") && this.number !== "exponent-digits") {
        this.number = "exponent";
        return true;
      }
      if (!" \t\r\n,]}".includes(char)) this.fail();
      this.finish();
      return false;
    }
    if (" \t\r\n".includes(char)) return true;
    const expected = this.stack.at(-1);
    if (expected === "colon") {
      if (char !== ":") this.fail();
      this.stack[this.stack.length - 1] = "object-value";
      return true;
    }
    if (expected === "array-end" || expected === "object-end") {
      if (char === ",") {
        this.stack[this.stack.length - 1] = expected === "array-end" ? "value" : "key";
        return true;
      }
      if (char !== (expected === "array-end" ? "]" : "}")) this.fail();
      this.stack.pop();
      this.finish();
      return true;
    }
    if ((expected === "array-first" && char === "]") || (expected === "key-first" && char === "}")) {
      this.stack.pop();
      this.finish();
      return true;
    }
    if (expected === "key" || expected === "key-first") {
      if (char !== '"') this.fail();
      this.key = true;
      this.token = "string";
      return true;
    }
    if (char === "{" || char === "[") {
      this.stack.push(char === "{" ? "key-first" : "array-first");
    } else if (char === '"') this.token = "string";
    else if (char === "t" || char === "f" || char === "n") {
      this.token = "literal";
      this.literal = char === "t" ? "rue" : char === "f" ? "alse" : "ull";
    } else if (char === "-" || (char >= "0" && char <= "9")) {
      this.token = "number";
      this.number = char === "-" ? "sign" : char === "0" ? "zero" : "integer";
    } else this.fail();
    return true;
  }

  end(): void {
    if (this.token === "number" && this.numberComplete()) this.finish();
  }
}

/**
 * Stream JSONL or concatenated pretty-printed values. Definite corruption throws
 * with a file and line; a valid but incomplete prefix at EOF is ignored for live
 * logs. Each character is scanned once and each completed value parsed once.
 */
export async function* readJsonValues(filePath: string): AsyncGenerator<unknown> {
  const input = createReadStream(filePath, { encoding: "utf8" });
  let line = 1;
  const fail = (): never => {
    throw new JsonRecordError(`${filePath}:${line}: malformed JSON record`);
  };
  let prefix = new JsonPrefix(fail);
  let parts: string[] = [];
  try {
    for await (const chunk of input) {
      const text = String(chunk);
      let start = 0;
      for (let i = 0; i < text.length;) {
        if (parts.length === 0 && start === i && " \t\r\n".includes(text[i]!)) {
          if (text[i] === "\n") line++;
          start = ++i;
          continue;
        }
        const consumed = prefix.push(text[i]!);
        if (consumed) {
          if (text[i] === "\n") line++;
          i++;
        }
        if (prefix.done) {
          parts.push(text.slice(start, i));
          yield JSON.parse(parts.join(""));
          parts = [];
          prefix = new JsonPrefix(fail);
          start = i;
        }
      }
      if (start < text.length) parts.push(text.slice(start));
    }
    prefix.end();
    if (prefix.done) yield JSON.parse(parts.join(""));
  } finally {
    input.destroy();
  }
}

/** Probe JSON without rejecting text exports. File access errors still throw. */
export async function readFirstJsonValue(filePath: string): Promise<unknown> {
  try {
    for await (const value of readJsonValues(filePath)) return value;
  } catch (error) {
    if (!(error instanceof JsonRecordError)) throw error;
  }
  return null;
}

/** Read just the first non-empty line of a file. */
export async function readFirstLine(filePath: string): Promise<string | null> {
  const lines = await readFirstLines(filePath, 1);
  return lines[0] ?? null;
}

/** Read up to `n` non-empty lines of a file. */
export async function readFirstLines(
  filePath: string,
  n: number,
): Promise<string[]> {
  let fh;
  try {
    fh = await open(filePath, "r");
  } catch {
    return [];
  }
  try {
    const input = fh.createReadStream({ encoding: "utf8", autoClose: false });
    const rl = createInterface({ input, crlfDelay: Infinity });
    try {
      const out: string[] = [];
      for await (const line of rl) {
        if (!line.trim()) continue;
        out.push(line);
        if (out.length >= n) break;
      }
      return out;
    } finally {
      rl.close();
      input.destroy();
    }
  } finally {
    await fh.close();
  }
}
