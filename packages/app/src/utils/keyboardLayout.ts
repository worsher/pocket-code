/**
 * KeyboardAvoidingView is rendered below the app header, while Android reports
 * the IME position in screen coordinates. Include the full screen-space origin
 * of that view so the bottom input clears the keyboard in edge-to-edge mode.
 */
export function getKeyboardVerticalOffset(
  platform: string,
  safeAreaTop: number,
  headerHeight: number
): number {
  return platform === "android" ? safeAreaTop + headerHeight : safeAreaTop;
}
