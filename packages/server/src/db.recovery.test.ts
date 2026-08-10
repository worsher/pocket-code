import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { ensureWorkspaceProject, initDb } from "./db.js";

const PROJECT_ID = "018f00d2-8931-7bc0-aad1-1ec83b13f982";

beforeAll(async () => {
  await initDb();
});

describe("database file recovery", () => {
  it("restores an unreadable primary database from its last valid backup", async () => {
    ensureWorkspaceProject(
      "recovery-user",
      PROJECT_ID,
      (() => {
        const values = [
          "550e8400-e29b-41d4-a716-446655440000",
          "74f1d64f-bf59-46a9-aa0b-7dcf42b95cab",
        ];
        return () => values.shift()!;
      })()
    );

    const primaryPath = process.env.DB_PATH!;
    const backupPath = `${primaryPath}.backup`;
    expect(existsSync(backupPath)).toBe(true);
    writeFileSync(primaryPath, "not-a-sqlite-database");

    await initDb();

    expect(readFileSync(primaryPath).subarray(0, 6).toString()).toBe("SQLite");
    expect(existsSync(backupPath)).toBe(true);
  });
});
