import React from "react";
import {
  View,
  Image,
  TouchableOpacity,
  Text,
  StyleSheet,
  ScrollView,
  Alert,
  ActionSheetIOS,
  Platform,
} from "react-native";
import * as ExpoImagePicker from "expo-image-picker";

// ── Types ─────────────────────────────────────────────

export interface ImageAttachment {
  uri: string;
  base64: string;
  mimeType: "image/jpeg" | "image/png";
}

const MAX_IMAGES = 3;

// ── Pick images ───────────────────────────────────────

async function pickFromCamera(): Promise<ImageAttachment | null> {
  const permission = await ExpoImagePicker.requestCameraPermissionsAsync();
  if (!permission.granted) {
    Alert.alert("权限不足", "需要相机权限才能拍照");
    return null;
  }
  const result = await ExpoImagePicker.launchCameraAsync({
    mediaTypes: ["images"],
    quality: 0.7,
    base64: true,
    allowsEditing: false,
  });
  if (result.canceled || !result.assets?.[0]) return null;
  const asset = result.assets[0];
  if (!asset.base64) return null;
  return {
    uri: asset.uri,
    base64: asset.base64,
    mimeType: asset.mimeType === "image/png" ? "image/png" : "image/jpeg",
  };
}

async function pickFromGallery(): Promise<ImageAttachment | null> {
  const permission = await ExpoImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted) {
    Alert.alert("权限不足", "需要相册权限才能选择图片");
    return null;
  }
  const result = await ExpoImagePicker.launchImageLibraryAsync({
    mediaTypes: ["images"],
    quality: 0.7,
    base64: true,
    allowsEditing: false,
  });
  if (result.canceled || !result.assets?.[0]) return null;
  const asset = result.assets[0];
  if (!asset.base64) return null;
  return {
    uri: asset.uri,
    base64: asset.base64,
    mimeType: asset.mimeType === "image/png" ? "image/png" : "image/jpeg",
  };
}

export async function showImagePicker(): Promise<ImageAttachment | null> {
  return new Promise((resolve) => {
    if (Platform.OS === "ios") {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options: ["取消", "拍照", "从相册选择"],
          cancelButtonIndex: 0,
        },
        async (buttonIndex) => {
          if (buttonIndex === 1) resolve(await pickFromCamera());
          else if (buttonIndex === 2) resolve(await pickFromGallery());
          else resolve(null);
        }
      );
    } else {
      // Android: use Alert as a simple action sheet
      Alert.alert("添加图片", "选择图片来源", [
        { text: "取消", style: "cancel", onPress: () => resolve(null) },
        { text: "拍照", onPress: async () => resolve(await pickFromCamera()) },
        {
          text: "从相册选择",
          onPress: async () => resolve(await pickFromGallery()),
        },
      ]);
    }
  });
}

// ── Preview bar ───────────────────────────────────────

interface ImagePreviewBarProps {
  images: ImageAttachment[];
  onRemove: (index: number) => void;
}

export function ImagePreviewBar({ images, onRemove }: ImagePreviewBarProps) {
  if (images.length === 0) return null;

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={styles.previewBar}
      contentContainerStyle={styles.previewContent}
    >
      {images.map((img, i) => (
        <View key={img.uri} style={styles.previewItem}>
          <Image source={{ uri: img.uri }} style={styles.previewImage} />
          <TouchableOpacity
            style={styles.removeButton}
            onPress={() => onRemove(i)}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Text style={styles.removeText}>x</Text>
          </TouchableOpacity>
        </View>
      ))}
      {images.length < MAX_IMAGES && (
        <Text style={styles.countHint}>
          {images.length}/{MAX_IMAGES}
        </Text>
      )}
    </ScrollView>
  );
}

// ── Styles ────────────────────────────────────────────

const styles = StyleSheet.create({
  previewBar: {
    maxHeight: 76,
    backgroundColor: "#1C1C1E",
    borderTopWidth: 0.5,
    borderTopColor: "#38383A",
  },
  previewContent: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    alignItems: "center",
    gap: 8,
  },
  previewItem: {
    position: "relative",
    marginRight: 8,
  },
  previewImage: {
    width: 60,
    height: 60,
    borderRadius: 8,
    backgroundColor: "#2C2C2E",
  },
  removeButton: {
    position: "absolute",
    top: -4,
    right: -4,
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: "#FF453A",
    justifyContent: "center",
    alignItems: "center",
  },
  removeText: {
    color: "#FFFFFF",
    fontSize: 11,
    fontWeight: "700",
    lineHeight: 13,
  },
  countHint: {
    color: "#636366",
    fontSize: 12,
    alignSelf: "center",
  },
});
