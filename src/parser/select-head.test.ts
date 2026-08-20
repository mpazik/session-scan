import { describe, expect, test } from "bun:test";
import { selectHeadPath } from "./select-head.js";

type Entry = { id: string; parentId: string | null; value?: string };

const entries: Entry[] = [
  { id: "root", parentId: null },
  { id: "left", parentId: "root" },
  { id: "right", parentId: "root" },
  { id: "head", parentId: "left" },
  { id: "later", parentId: "head" },
];

describe("selectHeadPath", () => {
  test("selects an inclusive root-to-head path in source order", () => {
    expect(selectHeadPath(entries, "head").map((entry) => entry.id)).toEqual([
      "root",
      "left",
      "head",
    ]);
  });

  test("excludes sibling branches and later descendants", () => {
    expect(selectHeadPath(entries, "left").map((entry) => entry.id)).toEqual([
      "root",
      "left",
    ]);
  });

  test("allows an external parent boundary", () => {
    expect(
      selectHeadPath([{ id: "head", parentId: "outside" }], "head"),
    ).toEqual([{ id: "head", parentId: "outside" }]);
  });

  test("rejects an unknown head", () => {
    expect(() => selectHeadPath(entries, "missing")).toThrow(
      'head "missing" was not found',
    );
  });

  test("rejects parent cycles", () => {
    expect(() =>
      selectHeadPath(
        [
          { id: "a", parentId: "b" },
          { id: "b", parentId: "a" },
        ],
        "a",
      ),
    ).toThrow('cannot select head "a": parent cycle detected');
  });

  test("rejects duplicate IDs", () => {
    expect(() =>
      selectHeadPath(
        [
          { id: "a", parentId: null },
          { id: "a", parentId: null },
        ],
        "a",
      ),
    ).toThrow('duplicate entry ID "a"');
  });
});
