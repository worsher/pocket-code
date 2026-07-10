import { describe, it, expect, afterEach } from "vitest";
import { loadOrCreateIdentity } from "./identity.js";
import { rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const TMP = join(tmpdir(), `pc-identity-test-${process.pid}.json`);
afterEach(() => { if (existsSync(TMP)) rmSync(TMP); });

describe("loadOrCreateIdentity", () => {
  it("生成的 machineId 是纯 16 位 hex,无 m_ 前缀(DNS-safe)", () => {
    const id = loadOrCreateIdentity(TMP, "test-host").machineId;
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(id.startsWith("m_")).toBe(false);
  });
  it("已存在文件时读回原值不重生成", () => {
    const first = loadOrCreateIdentity(TMP, "h").machineId;
    const second = loadOrCreateIdentity(TMP, "h").machineId;
    expect(second).toBe(first);
  });
});
