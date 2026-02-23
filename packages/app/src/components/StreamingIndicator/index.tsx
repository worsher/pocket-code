import React, { useEffect, useRef, useState } from "react";
import { View, Text, Animated, StyleSheet } from "react-native";

export type StreamingPhase =
  | "connecting"
  | "thinking"
  | "generating"
  | "tool-calling"
  | "tool-running"
  | "idle";

interface StreamingIndicatorProps {
  phase: StreamingPhase;
  toolName?: string;
}

const PHASE_CONFIG: Record<
  Exclude<StreamingPhase, "idle">,
  { icon: string; label: string }
> = {
  connecting: { icon: "◉", label: "连接中..." },
  thinking: { icon: "◎", label: "正在思考..." },
  generating: { icon: "▍", label: "正在回复..." },
  "tool-calling": { icon: "⚙", label: "准备执行" },
  "tool-running": { icon: "⏳", label: "执行中" },
};

export default function StreamingIndicator({
  phase,
  toolName,
}: StreamingIndicatorProps) {
  const pulseAnim = useRef(new Animated.Value(0.4)).current;
  const rotateAnim = useRef(new Animated.Value(0)).current;
  const cursorAnim = useRef(new Animated.Value(1)).current;
  const [elapsed, setElapsed] = useState(0);

  // Pulse animation for connecting
  useEffect(() => {
    if (phase === "connecting") {
      const anim = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, {
            toValue: 1,
            duration: 600,
            useNativeDriver: true,
          }),
          Animated.timing(pulseAnim, {
            toValue: 0.4,
            duration: 600,
            useNativeDriver: true,
          }),
        ])
      );
      anim.start();
      return () => anim.stop();
    }
  }, [phase, pulseAnim]);

  // Rotate animation for thinking / tool-running
  useEffect(() => {
    if (phase === "thinking" || phase === "tool-running") {
      rotateAnim.setValue(0);
      const anim = Animated.loop(
        Animated.timing(rotateAnim, {
          toValue: 1,
          duration: 1500,
          useNativeDriver: true,
        })
      );
      anim.start();
      return () => anim.stop();
    }
  }, [phase, rotateAnim]);

  // Cursor blink for generating
  useEffect(() => {
    if (phase === "generating") {
      const anim = Animated.loop(
        Animated.sequence([
          Animated.timing(cursorAnim, {
            toValue: 0,
            duration: 500,
            useNativeDriver: true,
          }),
          Animated.timing(cursorAnim, {
            toValue: 1,
            duration: 500,
            useNativeDriver: true,
          }),
        ])
      );
      anim.start();
      return () => anim.stop();
    }
  }, [phase, cursorAnim]);

  // Timer for tool-running
  useEffect(() => {
    if (phase === "tool-running") {
      setElapsed(0);
      const timer = setInterval(() => {
        setElapsed((prev) => prev + 1);
      }, 1000);
      return () => clearInterval(timer);
    } else {
      setElapsed(0);
    }
  }, [phase]);

  if (phase === "idle") return null;

  const config = PHASE_CONFIG[phase];
  const rotate = rotateAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ["0deg", "360deg"],
  });

  let toolLabel = config.label;
  if (toolName && (phase === "tool-calling" || phase === "tool-running")) {
    toolLabel = `${config.label} ${toolName}`;
    if (phase === "tool-running" && elapsed > 0) {
      toolLabel += ` (${elapsed}s)`;
    }
  }

  return (
    <View style={styles.container}>
      {phase === "connecting" && (
        <Animated.Text style={[styles.icon, { opacity: pulseAnim }]}>
          {config.icon}
        </Animated.Text>
      )}
      {phase === "thinking" && (
        <Animated.Text
          style={[styles.icon, { transform: [{ rotate }] }]}
        >
          {config.icon}
        </Animated.Text>
      )}
      {phase === "generating" && (
        <Animated.Text
          style={[styles.cursorIcon, { opacity: cursorAnim }]}
        >
          {config.icon}
        </Animated.Text>
      )}
      {phase === "tool-calling" && (
        <Text style={styles.icon}>{config.icon}</Text>
      )}
      {phase === "tool-running" && (
        <Animated.Text
          style={[styles.icon, { transform: [{ rotate }] }]}
        >
          {config.icon}
        </Animated.Text>
      )}
      <Text style={styles.label}>{toolLabel}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 6,
    gap: 6,
  },
  icon: {
    color: "#8E8E93",
    fontSize: 14,
  },
  cursorIcon: {
    color: "#007AFF",
    fontSize: 16,
    fontWeight: "700",
  },
  label: {
    color: "#8E8E93",
    fontSize: 13,
  },
});
