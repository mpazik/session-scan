import { afterEach, expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFirstJsonValue, readFirstLines, readJsonValues } from "./read-lines.js";
import claudeExport from "../adapters/claude-export.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function file(text: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "session-scan-json-"));
  directories.push(directory);
  const path = join(directory, "session.jsonl");
  await writeFile(path, text);
  return path;
}

async function assertValues(text: string, expected: unknown[]): Promise<void> {
  const values: unknown[] = [];
  for await (const value of readJsonValues(await file(text))) values.push(value);
  expect(values).toEqual(expected);
}

async function assertCorruption(text: string, line: number, expected: unknown[] = []): Promise<void> {
  const path = await file(text);
  const values: unknown[] = [];
  let failure: unknown;
  try {
    for await (const value of readJsonValues(path)) values.push(value);
  } catch (error) {
    failure = error;
  }
  expect(values).toEqual(expected);
  expect(failure).toBeInstanceOf(SyntaxError);
  expect((failure as Error).message).toContain(`${path}:${line}:`);
}

test("middle corruption fails visibly after previously yielded records", async () =>
  assertCorruption('{"id":1}\nnot-json\n{"id":2}\n', 2, [{ id: 1 }]));

test("a truncated live-log string preserves completed records", async () =>
  assertValues('{"id":1}\n{"message":"hel', [{ id: 1 }]));

test("an incomplete trailing object is tolerated", async () =>
  assertValues('{"id":1}\n{\n"id":2', [{ id: 1 }]));

test("a definitely invalid final object is not treated as truncation", async () =>
  assertCorruption('{"id":1}\n{"id":}', 2, [{ id: 1 }]));

test("an unclosed middle object does not swallow the next record", async () =>
  assertCorruption('{"id":1\n{"id":2}\n', 2));

test("pretty-printed concatenated nested values remain supported", async () =>
  assertValues('{\n "items": [1, {"ok": true}, null],\n "empty": {}\n}\n[\nfalse, []\n]\n', [
    { items: [1, { ok: true }, null], empty: {} }, [false, []],
  ]));

test("primitive values and JSON number forms remain supported", async () =>
  assertValues('null\ntrue\nfalse\n"text"\n-0\n1.25\n-2e+3\n4E-2', [null, true, false, "text", -0, 1.25, -2000, 0.04]));

test("a truncated exponent is ignored rather than emitted as a number", async () =>
  assertValues('1\n2e+', [1]));

test("a leading zero is definite corruption", async () => assertCorruption('01', 1));
test("a trailing array comma is definite corruption", async () => assertCorruption('[1,]', 1));
test("a missing object colon is definite corruption", async () => assertCorruption('{"id" 1}', 1));
test("invalid string escapes are definite corruption", async () => assertCorruption('"\\x"', 1));
test("invalid unicode escapes are definite corruption", async () => assertCorruption('"\\u12xz"', 1));
test("a literal newline inside a string is corruption, not truncation", async () => assertCorruption('"hello\n', 1));

test("escaped quotes, braces, and unicode do not affect record framing", async () =>
  assertValues('{"text":"\\\"}\\\\\\u263a"}\n', [{ text: '"}\\☺' }]));

test("blank lines and CRLF are accepted", async () => assertValues('\r\n \t\r\n{"id":1}\r\n', [{ id: 1 }]));
test("an empty file has no records", async () => assertValues('', []));

test("text export probing returns null without searching later JSON", async () => {
  expect(await readFirstJsonValue(await file('Human: hello\n{"id":1}\n'))).toBeNull();
});

test("Claude text exports remain detectable through the JSON probe", async () => {
  const path = await file('Claude Code v2.1.173\n❯ hello\n⏺ Hi\n');
  const first = await readFirstJsonValue(path);
  expect(first).toBeNull();
  expect(claudeExport.detect(first, path)).toBe(true);
});

test("probing malformed JSON returns null for adapter detection", async () => {
  expect(await readFirstJsonValue(await file('{"id":}\n'))).toBeNull();
});

test("probing an incomplete first value returns null", async () => {
  expect(await readFirstJsonValue(await file('{"id":'))).toBeNull();
});

test("probing stops after the first value without parsing later corruption", async () => {
  expect(await readFirstJsonValue(await file('{\n"id":1\n}\nnot-json\n'))).toEqual({ id: 1 });
});

test("missing files remain operational errors during probing", async () => {
  const path = await file('');
  await rm(path);
  await expect(readFirstJsonValue(path)).rejects.toMatchObject({ code: "ENOENT" });
});

test("missing files remain operational errors during iteration", async () => {
  const path = await file('');
  await rm(path);
  await expect(readJsonValues(path).next()).rejects.toMatchObject({ code: "ENOENT" });
});

test("large multiline records span stream chunks without losing content", async () => {
  const values = Array.from({ length: 30000 }, () => 'escaped " brace } ☺');
  await assertValues(JSON.stringify({ values }, null, 2) + '\n{"next":true}', [{ values }, { next: true }]);
});

test("line probing still returns only requested nonempty lines", async () => {
  expect(await readFirstLines(await file('\nfirst\n\nsecond\nthird\n'), 2)).toEqual(["first", "second"]);
});
