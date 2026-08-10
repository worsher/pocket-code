import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { atomicWriteFileSync } from "./atomicFile.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("atomicWriteFileSync", () => {
  it("replaces an existing file without leaving a temporary sibling", () => {
    const directory = mkdtempSync(join(tmpdir(), "pocket-code-atomic-"));
    temporaryDirectories.push(directory);
    const target = join(directory, "catalog.db");
    writeFileSync(target, "old");

    atomicWriteFileSync(target, Buffer.from("new"));

    expect(readFileSync(target, "utf8")).toBe("new");
    expect(readdirSync(directory)).toEqual(["catalog.db"]);
  });
});
