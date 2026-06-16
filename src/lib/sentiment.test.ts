import { describe, expect, test } from "bun:test";
import { frustrationScore } from "./sentiment.js";

describe("frustrationScore", () => {
  test("calm message scores 0 with no signals", () => {
    const r = frustrationScore("Could you add a test for the parser module?");
    expect(r.score).toBe(0);
    expect(r.signals).toEqual([]);
  });

  test("bare correction matches", () => {
    const r = frustrationScore("no");
    expect(r.signals).toContain("bare-no");
    expect(r.score).toBeCloseTo(0.4);
  });

  test("repeated-instruction phrasing matches", () => {
    const r = frustrationScore("I already said use the existing helper");
    expect(r.signals).toContain("already-said");
  });

  test("multiple signals accumulate", () => {
    const r = frustrationScore("that's wrong, you keep breaking the build");
    expect(r.signals).toEqual(
      expect.arrayContaining(["thats-wrong", "you-keep"]),
    );
    expect(r.score).toBeGreaterThan(0.6);
  });

  test("score is clamped to 1", () => {
    const r = frustrationScore(
      "STOP!! you keep doing this, that's wrong, I already said revert!!",
    );
    expect(r.score).toBe(1);
  });

  test("caps and punctuation count as signals", () => {
    const r = frustrationScore("WRONG FILE!!");
    expect(r.signals).toEqual(expect.arrayContaining(["caps", "exclamation"]));
  });

  test("brief reply to long output adds brief-correction when other signals match", () => {
    const withPrev = frustrationScore("no", { prevAssistantLength: 500 });
    expect(withPrev.signals).toContain("brief-correction");
    expect(withPrev.score).toBeCloseTo(0.6);
  });

  test("brevity alone is not a signal", () => {
    const r = frustrationScore("ok", { prevAssistantLength: 500 });
    expect(r.score).toBe(0);
    expect(r.signals).toEqual([]);
  });

  test("brevity bonus requires long previous assistant message", () => {
    const r = frustrationScore("no", { prevAssistantLength: 100 });
    expect(r.signals).not.toContain("brief-correction");
  });
});
