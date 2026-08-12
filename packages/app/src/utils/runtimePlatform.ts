import { Platform } from "react-native";

/** Isolated so pure settings persistence tests do not need to parse React Native internals. */
export const runtimePlatformOS = Platform.OS;
