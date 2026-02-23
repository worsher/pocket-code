import React, { useState, useRef, useEffect } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  Animated,
  StyleSheet,
  ScrollView,
} from "react-native";

interface ThinkingBlockProps {
  content: string;
  isStreaming?: boolean;
}

export default function ThinkingBlock({
  content,
  isStreaming,
}: ThinkingBlockProps) {
  const [expanded, setExpanded] = useState(false);
  const heightAnim = useRef(new Animated.Value(0)).current;

  const charCount = content.length;
  const label = isStreaming
    ? "正在思考..."
    : `思考过程 (${charCount}字)`;

  useEffect(() => {
    Animated.timing(heightAnim, {
      toValue: expanded ? 1 : 0,
      duration: 200,
      useNativeDriver: false,
    }).start();
  }, [expanded, heightAnim]);

  const maxHeight = heightAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [0, 500],
  });

  return (
    <View style={styles.container}>
      <TouchableOpacity
        style={styles.header}
        onPress={() => setExpanded(!expanded)}
        activeOpacity={0.7}
      >
        <View style={styles.headerLeft}>
          <Text style={styles.icon}>
            {expanded ? "▼" : "▶"}
          </Text>
          <Text style={styles.label}>{label}</Text>
        </View>
      </TouchableOpacity>

      <Animated.View style={[styles.body, { maxHeight }]}>
        <ScrollView
          style={styles.scroll}
          nestedScrollEnabled
        >
          <Text selectable style={styles.content}>
            {content}
          </Text>
        </ScrollView>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: "#1A1A1C",
    borderRadius: 8,
    borderLeftWidth: 2,
    borderLeftColor: "#BF5AF2",
    marginBottom: 8,
    overflow: "hidden",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  headerLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  icon: {
    color: "#BF5AF2",
    fontSize: 10,
  },
  label: {
    color: "#8E8E93",
    fontSize: 13,
    fontStyle: "italic",
  },
  body: {
    overflow: "hidden",
  },
  scroll: {
    maxHeight: 500,
  },
  content: {
    color: "#8E8E93",
    fontSize: 13,
    lineHeight: 19,
    paddingHorizontal: 10,
    paddingBottom: 10,
    fontStyle: "italic",
  },
});
