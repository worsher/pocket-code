import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { startManaged, stopManaged, listManaged, shutdownAll, __setSpawnForTest } from "./processRegistry.js";

// 假子进程:带 pid、可发 close、记录 kill 调用
class FakeChild extends EventEmitter {
  pid = Math.floor(Math.random() * 90000) + 1000;
  unref = vi.fn();
  kill = vi.fn();
}

let spawned: { cmd: string; args: readonly string[]; opts: any; child: FakeChild }[] = [];
function fakeSpawn(cmd: string, args?: readonly string[], opts?: any): any {
  const child = new FakeChild();
  spawned.push({ cmd, args: args ?? [], opts, child });
  return child;
}

const ORIGINAL_DOCKER_ENABLED = process.env.DOCKER_ENABLED;

beforeEach(() => { spawned = []; __setSpawnForTest(fakeSpawn as any); shutdownAll(); });
afterEach(() => {
  __setSpawnForTest(null);
  vi.restoreAllMocks();
  if (ORIGINAL_DOCKER_ENABLED === undefined) delete process.env.DOCKER_ENABLED;
  else process.env.DOCKER_ENABLED = ORIGINAL_DOCKER_ENABLED;
});

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

  // I-1 回归:host 分支须把 opts.cwd 透传给 spawn 的第三参，否则子进程继承 daemon 自己的 cwd
  // (pm2 启动目录=仓库根)，导致 "npm run dev" 在错误目录下报 missing script。
  it("host 分支透传 cwd 给 spawn options", async () => {
    await startManaged("/ws", "npm run dev", { cwd: "/ws/sub" });
    expect(spawned[0].opts).toMatchObject({ cwd: "/ws/sub", shell: true });
  });

  it("不传 cwd 时 spawn options.cwd 为 undefined(兼容现状)", async () => {
    await startManaged("/ws/a", "npm run dev");
    expect(spawned[0].opts?.cwd).toBeUndefined();
  });
});

describe("processRegistry (docker mode)", () => {
  beforeEach(() => { process.env.DOCKER_ENABLED = "true"; });

  it("docker 分支透传 containerCwd 为 -w 参数", async () => {
    await startManaged("/ws", "npm run dev", { containerId: "c1", containerCwd: "/workspace/sub" });
    expect(spawned[0].cmd).toBe("docker");
    const args = spawned[0].args;
    const wIndex = args.indexOf("-w");
    expect(wIndex).toBeGreaterThanOrEqual(0);
    expect(args[wIndex + 1]).toBe("/workspace/sub");
  });

  it("docker 分支不传 containerCwd 时不含 -w(兼容现状)", async () => {
    await startManaged("/ws", "npm run dev", { containerId: "c1" });
    expect(spawned[0].args).not.toContain("-w");
  });
});
