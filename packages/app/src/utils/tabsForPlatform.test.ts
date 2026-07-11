import { describe, expect, it } from "vitest";
import { ALL_TABS, tabsForPlatform } from "./tabsForPlatform";

describe("tabsForPlatform", () => {
  it("iOS 不含 terminal(本地终端为 Android 专属)", () => {
    expect(tabsForPlatform("ios")).toEqual(["chat", "files", "preview"]);
  });

  it("Android 含全部 Tab(行为零变化)", () => {
    expect(tabsForPlatform("android")).toEqual([...ALL_TABS]);
  });

  it("其他平台(web 等)含全部 Tab(维持现状,本次只隔离 iOS)", () => {
    expect(tabsForPlatform("web")).toEqual([...ALL_TABS]);
  });
});
