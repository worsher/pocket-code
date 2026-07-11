// Tab 栏平台过滤(纯函数,不 import react-native —— 便于 vitest 直测)。
// iOS 沙箱禁 fork/exec,本地终端为 Android 专属 → iOS 不渲染 terminal Tab。
export const ALL_TABS = ["chat", "terminal", "files", "preview"] as const;
export type TabKey = (typeof ALL_TABS)[number];

export function tabsForPlatform(os: string): readonly TabKey[] {
  return os === "ios" ? ALL_TABS.filter((t) => t !== "terminal") : ALL_TABS;
}
