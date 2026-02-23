import React, { useState } from "react";
import {
  View,
  Text,
  Image,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActionSheetIOS,
  Platform,
  Alert,
} from "react-native";
import * as Clipboard from "expo-clipboard";
import Markdown, { type RenderRules } from "react-native-markdown-display";
import type { Message, ToolCall, StreamingPhase } from "../../hooks/useAgent";
import StreamingIndicator from "../StreamingIndicator";
import ThinkingBlock from "../ThinkingBlock";
import DiffPreview from "../DiffPreview";
import TerminalOutput from "../TerminalOutput";
import CodeBlock from "../CodeBlock";
import FileChangeSummary from "../FileChangeSummary";

const COLLAPSE_HEIGHT = 300;

function createRules(): RenderRules {
  return {
    textgroup: (node, children) => (
      <Text key={node.key} selectable>
        {children}
      </Text>
    ),
    fence: (node) => {
      const code = node.content || "";
      const language = (node as any).sourceInfo || "";
      return (
        <CodeBlock
          key={node.key}
          nodeKey={node.key}
          code={code}
          language={language}
        />
      );
    },
    code_block: (node) => {
      const code = node.content || "";
      return (
        <CodeBlock key={node.key} nodeKey={node.key} code={code} />
      );
    },
  };
}

const rules = createRules();

interface ChatMessageProps {
  message: Message;
  streamingPhase?: StreamingPhase;
  currentToolName?: string;
  onEditResend?: (messageId: string, newContent: string) => void;
}

function ToolCallView({ toolCall }: { toolCall: ToolCall }) {
  const result = toolCall.result as Record<string, any> | undefined;

  // Special rendering for runCommand — show terminal output
  if (toolCall.toolName === "runCommand" && result) {
    return (
      <TerminalOutput
        command={(toolCall.args as any).command || ""}
        stdout={result.stdout}
        stderr={result.stderr}
        success={result.success}
        error={result.error}
      />
    );
  }

  // Special rendering for writeFile — show diff preview
  if (toolCall.toolName === "writeFile" && result?.success && result?.newContent) {
    return (
      <DiffPreview
        path={result.path || (toolCall.args as any).path || "unknown"}
        isNew={result.isNew ?? true}
        oldContent={result.oldContent}
        newContent={result.newContent}
      />
    );
  }

  const resultText =
    result && typeof result === "object"
      ? JSON.stringify(result, null, 2).slice(0, 500)
      : String(toolCall.result ?? "running...");

  return (
    <View style={styles.toolCall}>
      <Text style={styles.toolName}>
        {toolCall.toolName}({JSON.stringify(toolCall.args).slice(0, 100)})
      </Text>
      {toolCall.result != null && (
        <ScrollView horizontal style={styles.toolResult}>
          <Text style={styles.toolResultText}>{resultText}</Text>
        </ScrollView>
      )}
    </View>
  );
}

export default function ChatMessage({ message, streamingPhase, currentToolName, onEditResend }: ChatMessageProps) {
  const isUser = message.role === "user";
  const [isExpanded, setIsExpanded] = useState(false);
  const [contentHeight, setContentHeight] = useState(0);
  const shouldCollapse =
    !isUser && contentHeight > COLLAPSE_HEIGHT && !isExpanded;

  const handleLongPress = () => {
    if (!isUser || !onEditResend) return;

    const options = ["编辑重发", "从此处重新对话", "复制", "取消"];
    const cancelIndex = 3;

    if (Platform.OS === "ios") {
      ActionSheetIOS.showActionSheetWithOptions(
        { options, cancelButtonIndex: cancelIndex },
        (buttonIndex) => handleAction(buttonIndex),
      );
    } else {
      Alert.alert("操作", undefined, [
        { text: "编辑重发", onPress: () => handleAction(0) },
        { text: "从此处重新对话", onPress: () => handleAction(1) },
        { text: "复制", onPress: () => handleAction(2) },
        { text: "取消", style: "cancel" },
      ]);
    }
  };

  const handleAction = async (index: number) => {
    switch (index) {
      case 0: // 编辑重发 — use Alert.prompt on iOS, directly resend on Android
        if (Platform.OS === "ios") {
          Alert.prompt(
            "编辑消息",
            undefined,
            (text) => {
              if (text?.trim()) onEditResend?.(message.id, text.trim());
            },
            "plain-text",
            message.content,
          );
        } else {
          // Android doesn't support Alert.prompt, resend with original content
          onEditResend?.(message.id, message.content);
        }
        break;
      case 1: // 从此处重新对话
        onEditResend?.(message.id, message.content);
        break;
      case 2: // 复制
        await Clipboard.setStringAsync(message.content);
        break;
    }
  };

  return (
    <View
      style={[
        styles.container,
        isUser ? styles.userContainer : styles.assistantContainer,
      ]}
    >
      <TouchableOpacity
        activeOpacity={isUser ? 0.7 : 1}
        onLongPress={handleLongPress}
        style={[styles.bubble, isUser ? styles.userBubble : styles.assistantBubble]}
      >
        <View
          style={
            shouldCollapse
              ? { maxHeight: COLLAPSE_HEIGHT, overflow: "hidden" }
              : undefined
          }
          onLayout={(e) => {
            if (!isExpanded && contentHeight === 0) {
              setContentHeight(e.nativeEvent.layout.height);
            }
          }}
        >
          {isUser ? (
            <>
              {message.images && message.images.length > 0 && (
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  style={styles.imageRow}
                >
                  {message.images.map((img, idx) => (
                    <Image
                      key={idx}
                      source={{ uri: img.uri }}
                      style={styles.messageImage}
                      resizeMode="cover"
                    />
                  ))}
                </ScrollView>
              )}
              <Text selectable style={styles.userText}>
                {message.content || "..."}
              </Text>
            </>
          ) : (
            <>
              {message.thinking && (
                <ThinkingBlock
                  content={message.thinking}
                  isStreaming={streamingPhase === "thinking"}
                />
              )}
              {message.content ? (
                <Markdown style={markdownStyles} rules={rules}>
                  {message.content}
                </Markdown>
              ) : (
                !message.toolCalls?.length && (
                  <StreamingIndicator
                    phase={streamingPhase || "connecting"}
                    toolName={currentToolName}
                  />
                )
              )}
              {message.modelUsed && (
                <Text style={styles.modelTag}>via {message.modelUsed}</Text>
              )}
            </>
          )}
          {message.toolCalls?.map((tc, i) => (
            <ToolCallView key={i} toolCall={tc} />
          ))}
          {!isUser && !streamingPhase && message.toolCalls?.length ? (
            <FileChangeSummary toolCalls={message.toolCalls} />
          ) : null}
        </View>

        {shouldCollapse && (
          <>
            <View style={styles.fadeOverlay} />
            <TouchableOpacity
              style={styles.expandButton}
              onPress={() => setIsExpanded(true)}
            >
              <Text style={styles.expandButtonText}>展开全文 ▼</Text>
            </TouchableOpacity>
          </>
        )}
        {isExpanded && contentHeight > COLLAPSE_HEIGHT && (
          <TouchableOpacity
            style={styles.expandButton}
            onPress={() => setIsExpanded(false)}
          >
            <Text style={styles.expandButtonText}>收起 ▲</Text>
          </TouchableOpacity>
        )}
      </TouchableOpacity>
    </View>
  );
}

const markdownStyles = StyleSheet.create({
  body: {
    color: "#E5E5EA",
    fontSize: 15,
    lineHeight: 22,
  },
  heading1: {
    color: "#FFFFFF",
    fontSize: 20,
    fontWeight: "700" as const,
    marginTop: 8,
    marginBottom: 4,
  },
  heading2: {
    color: "#FFFFFF",
    fontSize: 18,
    fontWeight: "600" as const,
    marginTop: 6,
    marginBottom: 4,
  },
  heading3: {
    color: "#FFFFFF",
    fontSize: 16,
    fontWeight: "600" as const,
    marginTop: 4,
    marginBottom: 2,
  },
  code_inline: {
    backgroundColor: "#2C2C2E",
    color: "#FF9F0A",
    fontFamily: "monospace",
    fontSize: 13,
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderRadius: 4,
  },
  link: {
    color: "#007AFF",
  },
  strong: {
    color: "#FFFFFF",
    fontWeight: "600" as const,
  },
  em: {
    color: "#E5E5EA",
    fontStyle: "italic" as const,
  },
  bullet_list: {
    marginVertical: 4,
  },
  ordered_list: {
    marginVertical: 4,
  },
  list_item: {
    color: "#E5E5EA",
    fontSize: 15,
  },
  blockquote: {
    backgroundColor: "#1C1C1E",
    borderLeftWidth: 3,
    borderLeftColor: "#636366",
    paddingLeft: 10,
    paddingVertical: 4,
    marginVertical: 4,
  },
  hr: {
    backgroundColor: "#38383A",
    height: 1,
    marginVertical: 8,
  },
  paragraph: {
    marginTop: 0,
    marginBottom: 6,
  },
});

const styles = StyleSheet.create({
  container: {
    marginVertical: 4,
    paddingHorizontal: 12,
  },
  userContainer: {
    alignItems: "flex-end",
  },
  assistantContainer: {
    alignItems: "flex-start",
  },
  bubble: {
    maxWidth: "85%",
    borderRadius: 16,
    padding: 12,
  },
  userBubble: {
    backgroundColor: "#007AFF",
    borderBottomRightRadius: 4,
  },
  assistantBubble: {
    backgroundColor: "#1C1C1E",
    borderBottomLeftRadius: 4,
  },
  userText: {
    color: "#FFFFFF",
    fontSize: 15,
    lineHeight: 21,
  },
  toolCall: {
    marginTop: 8,
    backgroundColor: "#2C2C2E",
    borderRadius: 8,
    padding: 8,
  },
  toolName: {
    color: "#30D158",
    fontSize: 12,
    fontFamily: "monospace",
  },
  toolResult: {
    marginTop: 4,
    maxHeight: 120,
  },
  toolResultText: {
    color: "#8E8E93",
    fontSize: 11,
    fontFamily: "monospace",
  },
  fadeOverlay: {
    height: 40,
    marginTop: -40,
    backgroundColor: "rgba(28, 28, 30, 0.9)",
  },
  expandButton: {
    paddingVertical: 8,
    alignItems: "center",
  },
  expandButtonText: {
    color: "#007AFF",
    fontSize: 13,
    fontWeight: "500",
  },
  modelTag: {
    color: "#636366",
    fontSize: 11,
    marginTop: 4,
    fontStyle: "italic",
  },
  imageRow: {
    marginBottom: 8,
  },
  messageImage: {
    width: 140,
    height: 140,
    borderRadius: 8,
    marginRight: 6,
    backgroundColor: "#2C2C2E",
  },
});
