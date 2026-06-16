/**
 * Scanner loader. The scanner is the only user-extensible unit and is loaded by
 * path, like an adapter — never registered, no name, no `list`. Resolve the
 * path, take the module's default export, assert it's a function. Exactly one
 * `--scanner` per run.
 */

import { resolve } from "path";
import type { Scanner } from "../scanner.js";

export async function loadScanner(path: string): Promise<Scanner> {
  const abs = resolve(process.cwd(), path);
  let mod: { default?: unknown };
  try {
    mod = await import(abs);
  } catch (e) {
    throw new Error(`failed to load scanner ${path}: ${e}`);
  }
  const fn = mod.default;
  if (typeof fn !== "function") {
    throw new Error(
      `scanner ${path} must export a default function (got ${typeof fn})`,
    );
  }
  return fn as Scanner;
}
