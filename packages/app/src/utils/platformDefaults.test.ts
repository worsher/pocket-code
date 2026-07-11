import { describe, expect, it } from "vitest";
import { defaultWorkspaceMode } from "./platformDefaults";

describe("defaultWorkspaceMode", () => {
  it("iOS 默认 relay(本地 shell 为 Android 专属,沙箱禁 fork/exec)", () => {
    expect(defaultWorkspaceMode("ios")).toBe("relay");
  });

  it("Android 默认 local(行为零变化)", () => {
    expect(defaultWorkspaceMode("android")).toBe("local");
  });

  it("其他平台(web 等)默认 local(维持现状)", () => {
    expect(defaultWorkspaceMode("web")).toBe("local");
  });
});
