import React, { useState } from "react";
import { View, Text, StyleSheet, ScrollView, TouchableOpacity } from "react-native";
import * as Clipboard from "expo-clipboard";
import CodeHighlighter from "react-native-code-highlighter";

// Atom One Dark Reasonable theme (inlined to avoid Metro resolution issues
// with react-syntax-highlighter/dist/esm paths)
const atomOneDarkReasonable = {
  hljs: { display: "block", overflowX: "auto", padding: "0.5em", color: "#abb2bf", background: "#282c34" },
  "hljs-keyword": { color: "#F92672" },
  "hljs-operator": { color: "#F92672" },
  "hljs-pattern-match": { color: "#F92672" },
  "hljs-function": { color: "#61aeee" },
  "hljs-comment": { color: "#b18eb1", fontStyle: "italic" },
  "hljs-quote": { color: "#b18eb1", fontStyle: "italic" },
  "hljs-doctag": { color: "#c678dd" },
  "hljs-section": { color: "#e06c75" },
  "hljs-name": { color: "#e06c75" },
  "hljs-selector-tag": { color: "#e06c75" },
  "hljs-deletion": { color: "#e06c75" },
  "hljs-subst": { color: "#e06c75" },
  "hljs-literal": { color: "#56b6c2" },
  "hljs-string": { color: "#98c379" },
  "hljs-regexp": { color: "#98c379" },
  "hljs-addition": { color: "#98c379" },
  "hljs-attribute": { color: "#98c379" },
  "hljs-meta-string": { color: "#98c379" },
  "hljs-built_in": { color: "#e6c07b" },
  "hljs-attr": { color: "#d19a66" },
  "hljs-variable": { color: "#d19a66" },
  "hljs-template-variable": { color: "#d19a66" },
  "hljs-type": { color: "#d19a66" },
  "hljs-selector-class": { color: "#d19a66" },
  "hljs-number": { color: "#d19a66" },
  "hljs-symbol": { color: "#61aeee" },
  "hljs-bullet": { color: "#61aeee" },
  "hljs-link": { color: "#61aeee" },
  "hljs-meta": { color: "#61aeee" },
  "hljs-selector-id": { color: "#61aeee" },
  "hljs-title": { color: "#61aeee" },
  "hljs-emphasis": { fontStyle: "italic" },
  "hljs-strong": { fontWeight: "bold" },
};

interface CodeBlockProps {
  code: string;
  language?: string;
  nodeKey: string;
}

export default function CodeBlock({ code, language, nodeKey }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await Clipboard.setStringAsync(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <View key={nodeKey} style={styles.wrapper}>
      <View style={styles.header}>
        <Text style={styles.language}>{language || "code"}</Text>
        <TouchableOpacity onPress={handleCopy} style={styles.copyBtn}>
          <Text style={styles.copyText}>
            {copied ? "已复制 ✓" : "复制"}
          </Text>
        </TouchableOpacity>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        {/* @ts-ignore — children prop exists at runtime but missing from type defs */}
        <CodeHighlighter
          hljsStyle={atomOneDarkReasonable as any}
          language={language || "plaintext"}
          textStyle={styles.codeText}
          scrollViewProps={{ scrollEnabled: false }}
        >
          {code}
        </CodeHighlighter>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    backgroundColor: "#2C2C2E",
    borderRadius: 8,
    marginVertical: 6,
    overflow: "hidden",
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: "#3A3A3C",
  },
  language: {
    color: "#8E8E93",
    fontSize: 11,
    fontFamily: "monospace",
  },
  copyBtn: {
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  copyText: {
    color: "#007AFF",
    fontSize: 11,
    fontWeight: "500",
  },
  codeText: {
    fontFamily: "monospace",
    fontSize: 13,
    lineHeight: 20,
  },
});
