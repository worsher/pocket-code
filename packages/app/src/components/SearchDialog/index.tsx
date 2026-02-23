import React, { useState, useCallback, useRef } from "react";
import {
  View,
  Text,
  TextInput,
  FlatList,
  TouchableOpacity,
  Modal,
  StyleSheet,
} from "react-native";
import { searchSessions, type SearchResult } from "../../store/chatHistory";

interface SearchDialogProps {
  visible: boolean;
  onClose: () => void;
  onSelectSession: (sessionId: string) => void;
}

export default function SearchDialog({
  visible,
  onClose,
  onSelectSession,
}: SearchDialogProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleSearch = useCallback((text: string) => {
    setQuery(text);

    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (!text.trim()) {
      setResults([]);
      return;
    }

    debounceRef.current = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await searchSessions(text);
        setResults(res);
      } catch {
        setResults([]);
      } finally {
        setSearching(false);
      }
    }, 300);
  }, []);

  const handleSelect = useCallback(
    (item: SearchResult) => {
      onSelectSession(item.sessionId);
      onClose();
      setQuery("");
      setResults([]);
    },
    [onSelectSession, onClose]
  );

  const handleClose = useCallback(() => {
    onClose();
    setQuery("");
    setResults([]);
  }, [onClose]);

  // Highlight matching text in snippet
  const renderSnippet = (snippet: string) => {
    if (!query.trim()) return <Text style={styles.snippet}>{snippet}</Text>;

    const lowerSnippet = snippet.toLowerCase();
    const lowerQuery = query.toLowerCase();
    const idx = lowerSnippet.indexOf(lowerQuery);

    if (idx === -1) return <Text style={styles.snippet}>{snippet}</Text>;

    const before = snippet.slice(0, idx);
    const match = snippet.slice(idx, idx + query.length);
    const after = snippet.slice(idx + query.length);

    return (
      <Text style={styles.snippet}>
        {before}
        <Text style={styles.highlight}>{match}</Text>
        {after}
      </Text>
    );
  };

  const renderItem = ({ item }: { item: SearchResult }) => (
    <TouchableOpacity
      style={styles.resultItem}
      onPress={() => handleSelect(item)}
      activeOpacity={0.7}
    >
      <View style={styles.resultHeader}>
        <Text style={styles.sessionTitle} numberOfLines={1}>
          {item.sessionTitle}
        </Text>
        <Text style={styles.roleBadge}>
          {item.role === "user" ? "You" : "AI"}
        </Text>
      </View>
      {renderSnippet(item.snippet)}
    </TouchableOpacity>
  );

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={handleClose}
    >
      <View style={styles.container}>
        <View style={styles.header}>
          <TextInput
            style={styles.searchInput}
            value={query}
            onChangeText={handleSearch}
            placeholder="搜索对话内容..."
            placeholderTextColor="#636366"
            autoFocus
            returnKeyType="search"
          />
          <TouchableOpacity onPress={handleClose} style={styles.cancelButton}>
            <Text style={styles.cancelText}>取消</Text>
          </TouchableOpacity>
        </View>

        {searching && (
          <Text style={styles.statusText}>搜索中...</Text>
        )}

        {!searching && query.trim() && results.length === 0 && (
          <Text style={styles.statusText}>未找到匹配内容</Text>
        )}

        <FlatList
          data={results}
          renderItem={renderItem}
          keyExtractor={(item) => `${item.sessionId}_${item.messageId}`}
          contentContainerStyle={styles.listContent}
          keyboardShouldPersistTaps="handled"
        />
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#000000",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: "#1C1C1E",
    borderBottomWidth: 0.5,
    borderBottomColor: "#38383A",
  },
  searchInput: {
    flex: 1,
    backgroundColor: "#2C2C2E",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    color: "#FFFFFF",
    fontSize: 15,
  },
  cancelButton: {
    marginLeft: 10,
    paddingVertical: 6,
  },
  cancelText: {
    color: "#007AFF",
    fontSize: 15,
  },
  statusText: {
    color: "#636366",
    fontSize: 14,
    textAlign: "center",
    marginTop: 40,
  },
  listContent: {
    paddingVertical: 8,
  },
  resultItem: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 0.5,
    borderBottomColor: "#2C2C2E",
  },
  resultHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 4,
  },
  sessionTitle: {
    color: "#FFFFFF",
    fontSize: 14,
    fontWeight: "600",
    flex: 1,
    marginRight: 8,
  },
  roleBadge: {
    color: "#8E8E93",
    fontSize: 11,
    backgroundColor: "#2C2C2E",
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    overflow: "hidden",
  },
  snippet: {
    color: "#AEAEB2",
    fontSize: 13,
    lineHeight: 18,
  },
  highlight: {
    color: "#FFD60A",
    fontWeight: "600",
  },
});
