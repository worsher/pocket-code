import React, { useState, useCallback } from "react";
import {
  View,
  TextInput,
  TouchableOpacity,
  Text,
  StyleSheet,
} from "react-native";
import {
  showImagePicker,
  ImagePreviewBar,
  type ImageAttachment,
} from "../ImagePicker";

interface ChatInputProps {
  onSend: (text: string, images?: ImageAttachment[]) => void;
  onStop?: () => void;
  isStreaming?: boolean;
  disabled?: boolean;
}

export default function ChatInput({
  onSend,
  onStop,
  isStreaming,
  disabled,
}: ChatInputProps) {
  const [text, setText] = useState("");
  const [images, setImages] = useState<ImageAttachment[]>([]);

  const handleSend = () => {
    const trimmed = text.trim();
    if ((!trimmed && images.length === 0) || disabled) return;
    onSend(trimmed || "(图片)", images.length > 0 ? images : undefined);
    setText("");
    setImages([]);
  };

  const handleAttach = useCallback(async () => {
    if (images.length >= 3) return;
    const img = await showImagePicker();
    if (img) {
      setImages((prev) => [...prev, img]);
    }
  }, [images.length]);

  const handleRemoveImage = useCallback((index: number) => {
    setImages((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const canSend = (text.trim() || images.length > 0) && !disabled;

  return (
    <View>
      <ImagePreviewBar images={images} onRemove={handleRemoveImage} />
      <View style={styles.container}>
        <TouchableOpacity
          style={styles.attachButton}
          onPress={handleAttach}
          disabled={disabled || isStreaming}
        >
          <Text style={styles.attachButtonText}>+</Text>
        </TouchableOpacity>
        <TextInput
          style={styles.input}
          value={text}
          onChangeText={setText}
          placeholder={disabled ? "连接中..." : "Ask Pocket Code..."}
          placeholderTextColor="#636366"
          multiline
          maxLength={4000}
          onSubmitEditing={handleSend}
          blurOnSubmit={false}
        />
        {isStreaming ? (
          <TouchableOpacity style={styles.stopButton} onPress={onStop}>
            <Text style={styles.stopButtonText}>■</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity
            style={[
              styles.sendButton,
              !canSend && styles.sendButtonDisabled,
            ]}
            onPress={handleSend}
            disabled={!canSend}
          >
            <Text style={styles.sendButtonText}>Send</Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: "row",
    alignItems: "flex-end",
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: "#1C1C1E",
    borderTopWidth: 0.5,
    borderTopColor: "#38383A",
  },
  input: {
    flex: 1,
    backgroundColor: "#2C2C2E",
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 10,
    color: "#FFFFFF",
    fontSize: 15,
    maxHeight: 120,
    marginRight: 8,
  },
  attachButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "#2C2C2E",
    justifyContent: "center",
    alignItems: "center",
    marginRight: 8,
  },
  attachButtonText: {
    color: "#8E8E93",
    fontSize: 22,
    fontWeight: "400",
    marginTop: -1,
  },
  sendButton: {
    backgroundColor: "#007AFF",
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  sendButtonDisabled: {
    backgroundColor: "#38383A",
  },
  sendButtonText: {
    color: "#FFFFFF",
    fontSize: 15,
    fontWeight: "600",
  },
  stopButton: {
    backgroundColor: "#FF453A",
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  stopButtonText: {
    color: "#FFFFFF",
    fontSize: 15,
    fontWeight: "600",
  },
});
