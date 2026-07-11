import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { startManaged, stopManaged, listManaged, shutdownAll, __setSpawnForTest } from "./processRegistry.js";

// 假子进程:带 pid、可发 close、记录 kill 调用
class FakeChild extends EventEmitter {
  pid = Math.floor(Math.random() * 90000) + 1000;
  unref = vi.fn();
  kill = vi.fn();
}

let spawned: { cmd: string; args: readonly string[]; child: FakeChild }[] = [];
function fakeSpawn(cmd: string, args?: readonly string[]): any {
  const child = new FakeChild();
  spawned.push({ cmd, args: args ?? [], child });
  return child;
}

beforeEach(() => { spawned = []; __setSpawnForTest(fakeSpawn as any); shutdownAll(); });
afterEach(() => { __setSpawnForTest(null); vi.restoreAllMocks(); });

describe("processRegistry (host mode)", () => {
  it("startManaged 返回 p_ 前缀 id 并登记", async () => {
    const { processId } = await startManaged("/ws/a", "npm run dev");
    expect(processId).toMatch(/^p_[0-9a-f]+$/);
    const list = listManaged("/ws/a");
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ processId, workspace: "/ws/a", command: "npm run dev" });
  });

  it("shell 模式起进程且 unref", async () => {
    await startManaged("/ws/a", "vite");
    expect(spawned[0].cmd).toBe("vite");
    expect(spawned[0].child.unref).toHaveBeenCalled();
  });

  it("同 workspace+同 command 再起先杀旧", async () => {
    const first = await startManaged("/ws/a", "npm run dev");
    const firstChild = spawned[0].child;
    await startManaged("/ws/a", "npm run dev");
    expect(firstChild.kill).toHaveBeenCalled();       // 旧的被 stop
    expect(listManaged("/ws/a")).toHaveLength(1);      // 不堆积
    expect(listManaged("/ws/a")[0].processId).not.toBe(first.processId);
  });

  it("进程自然退出自动摘除", async () => {
    await startManaged("/ws/a", "server");
    spawned[0].child.emit("close", 0);
    expect(listManaged("/ws/a")).toHaveLength(0);
  });

  it("listManaged 按 workspace 过滤;无参返回全部", async () => {
    await startManaged("/ws/a", "a");
    await startManaged("/ws/b", "b");
    expect(listManaged("/ws/a")).toHaveLength(1);
    expect(listManaged()).toHaveLength(2);
  });

  it("stopManaged 未知 id 安全无操作", async () => {
    await expect(stopManaged("p_nope")).resolves.toBeUndefined();
  });

  it("shutdownAll 清空全部", async () => {
    await startManaged("/ws/a", "a");
    await startManaged("/ws/b", "b");
    shutdownAll();
    expect(listManaged()).toHaveLength(0);
  });
});
