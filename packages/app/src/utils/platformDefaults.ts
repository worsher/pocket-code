// 平台相关默认值(纯函数,不 import react-native —— 便于 vitest 直测)。
// iOS 沙箱禁 fork/exec,本地 shell 为 Android 专属 → iOS 默认走 relay。
export function defaultWorkspaceMode(os: string): "local" | "relay" {
  return os === "ios" ? "relay" : "local";
}
