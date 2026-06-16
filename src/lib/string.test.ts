import { describe, expect, test } from "bun:test";
import { stripAnsi, truncLine, truncate } from "./string.js";

describe("truncate", () => {
  test("returns short text unchanged", () => {
    expect(truncate("hello")).toBe("hello");
  });

  test("returns text at exactly maxLen unchanged", () => {
    expect(truncate("abcde", 5)).toBe("abcde");
  });

  test("cuts at maxLen and appends ellipsis", () => {
    expect(truncate("abcdefgh", 5)).toBe("abcde...");
  });

  test("defaults to 300 chars", () => {
    const long = "x".repeat(301);
    expect(truncate(long)).toBe("x".repeat(300) + "...");
  });
});

describe("truncLine", () => {
  test("flattens newlines to spaces and trims", () => {
    expect(truncLine("  a\nb\nc  ")).toBe("a b c");
  });

  test("truncates the flattened line", () => {
    expect(truncLine("abc\ndef", 4)).toBe("abc ...");
  });

  test("defaults to 120 chars", () => {
    const long = "x".repeat(121);
    expect(truncLine(long)).toBe("x".repeat(120) + "...");
  });
});

describe("stripAnsi", () => {
  test("removes color codes", () => {
    expect(stripAnsi("\x1b[31merror\x1b[0m: failed")).toBe("error: failed");
  });

  test("removes multi-parameter SGR codes", () => {
    expect(stripAnsi("\x1b[1;32mok\x1b[0m")).toBe("ok");
  });

  test("leaves plain text untouched", () => {
    expect(stripAnsi("no escapes here")).toBe("no escapes here");
  });
});
