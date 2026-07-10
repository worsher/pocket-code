import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadOrCreateIdentity } from "./identity";

describe("loadOrCreateIdentity", () => {
  it("首次生成 m_ 前缀 id 并落盘,二次读取稳定复用", () => {
    const file = join(mkdtempSync(join(tmpdir(), "pt-")), "id.json");
    const first = loadOrCreateIdentity(file, "box");
    expect(first.machineId).toMatch(/^m_[0-9a-f]{16}$/);
    expect(first.machineName).toBe("box");
    const second = loadOrCreateIdentity(file, "other-name");
    expect(second.machineId).toBe(first.machineId);
    // 落盘的 name 优先于 defaultName
    expect(second.machineName).toBe("box");
    expect(JSON.parse(readFileSync(file, "utf-8")).machineId).toBe(first.machineId);
  });

  it("损坏文件按首次处理重建", () => {
    const file = join(mkdtempSync(join(tmpdir(), "pt-")), "id.json");
    writeFileSync(file, "not-json{{{");
    const identity = loadOrCreateIdentity(file, "box");
    expect(identity.machineId).toMatch(/^m_[0-9a-f]{16}$/);
    expect(JSON.parse(readFileSync(file, "utf-8")).machineId).toBe(identity.machineId);
  });
});
