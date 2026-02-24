import React, { useEffect, useRef, useState, useMemo, useCallback } from "react";
import {
    View,
    Text,
    FlatList,
    StyleSheet,
    TouchableOpacity,
    TextInput,
    Platform,
    Dimensions,
} from "react-native";
import { PocketTerminal, getNativeLibDir } from "pocket-terminal-module";
import KeyboardToolbar from "./KeyboardToolbar";
import RuntimeSetup from "../RuntimeSetup";
import { getRuntimeStatus } from "../../services/runtimeManager";

// ── Types ──────────────────────────────────────
interface TextSpan {
    text: string;
    fg: string;
    bg: string;
    bold: boolean;
    underline: boolean;
    italic: boolean;
    reverse: boolean;
}

// ── Config ─────────────────────────────────────
const FONT_SIZE = 13;
const CHAR_WIDTH = 7.8;
const LINE_HEIGHT = 16;

function calcCols(): number {
    const screenWidth = Dimensions.get("window").width;
    const padding = 10 * 2; // left + right padding
    return Math.floor((screenWidth - padding) / CHAR_WIDTH);
}

// ── Cell parser ─────────────────────────────────
function parseCells(view: Uint32Array, offset: number, count: number): TextSpan[] {
    const rowSpans: TextSpan[] = [];
    let currentSpan: TextSpan | null = null;
    let idx = offset;

    for (let c = 0; c < count; c++) {
        const chCode = view[idx++];
        const fgCode = view[idx++];
        const bgCode = view[idx++];
        const flags = view[idx++];

        let fgHex = "#" + ("000000" + (fgCode & 0xffffff).toString(16)).slice(-6);
        let bgHex = "#" + ("000000" + (bgCode & 0xffffff).toString(16)).slice(-6);

        if (fgHex === "#000000" && bgHex === "#000000") {
            fgHex = "#FFFFFF";
        }

        const bold = (flags & (1 << 0)) !== 0;
        const underline = (flags & (1 << 1)) !== 0;
        const italic = (flags & (1 << 2)) !== 0;
        const reverse = (flags & (1 << 4)) !== 0;
        const char = chCode === 0 ? " " : String.fromCodePoint(chCode);

        if (!currentSpan) {
            currentSpan = { text: char, fg: fgHex, bg: bgHex, bold, underline, italic, reverse };
        } else if (
            currentSpan.fg === fgHex &&
            currentSpan.bg === bgHex &&
            currentSpan.bold === bold &&
            currentSpan.underline === underline &&
            currentSpan.italic === italic &&
            currentSpan.reverse === reverse
        ) {
            currentSpan.text += char;
        } else {
            rowSpans.push(currentSpan);
            currentSpan = { text: char, fg: fgHex, bg: bgHex, bold, underline, italic, reverse };
        }
    }
    if (currentSpan) rowSpans.push(currentSpan);
    return rowSpans;
}

// ── TerminalScreen ──────────────────────────────
export interface TerminalScreenHandle {
    write: (data: string) => void;
}

interface TerminalScreenProps {
    /** Called when the terminal exits or is paused. */
    onClose?: () => void;
}

export default function TerminalScreen({ onClose }: TerminalScreenProps) {
    const [historyData, setHistoryData] = useState<TextSpan[][]>([]);
    const [rowsData, setRowsData] = useState<TextSpan[][]>([]);
    const [cursor, setCursor] = useState({ x: 0, y: 0 });
    const [blink, setBlink] = useState(true);
    const [cols, setCols] = useState(calcCols());
    // RuntimeSetup: null = checking, true = show setup, false = go to terminal
    const [showSetup, setShowSetup] = useState<boolean | null>(null);

    // On mount: check if we should show RuntimeSetup first
    useEffect(() => {
        getRuntimeStatus().then((status) => {
            // Show setup only when proot is available but rootfs not yet installed.
            // If proot is not available at all, skip setup and go straight to terminal.
            const needsSetup = status.prootAvailable && !status.rootfsInstalled;
            setShowSetup(needsSetup);
        }).catch(() => {
            setShowSetup(false); // On error, fall through to terminal
        });
    }, []);

    const termRef = useRef<PocketTerminal | null>(null);
    const inputRef = useRef<TextInput | null>(null);
    const flatListRef = useRef<FlatList | null>(null);
    // Track PTY start state so we don't restart on re-render
    const ptyStartedRef = useRef(false);
    // Adaptive poll interval: fast when user is typing, slow otherwise
    const lastInputRef = useRef(Date.now());

    // ── PTY lifecycle ──────────────────────────────
    useEffect(() => {
        const term = new PocketTerminal(24, cols);
        termRef.current = term;

        if (!ptyStartedRef.current) {
            const success = term.startPty();
            ptyStartedRef.current = true;
            if (!success) {
                term.write("Failed to start PTY \u2014 /system/bin/sh unavailable\r\n");
            } else {
                // If Alpine rootfs is installed, auto-launch proot to enter Alpine shell
                getRuntimeStatus().then((status) => {
                    if (status.rootfsInstalled) {
                        const nativeLibDir = getNativeLibDir();
                        if (nativeLibDir) {
                            const { Paths } = require('expo-file-system');
                            const prootBin = `${nativeLibDir}/libproot.so`;
                            const prootLoaderBin = `${nativeLibDir}/libproot-loader.so`;
                            const rootfsPath = Paths.document.uri.replace('file://', '') + 'rootfs';
                            const tmpDir = Paths.cache.uri.replace('file://', '') + 'proot-tmp';
                            // Wait for shell to initialize, then clean line and send command
                            setTimeout(() => {
                                // Use export to pass PROOT_LOADER to proot. PROOT_LOADER points
                                // to libproot-loader.so in nativeLibDir (app_lib_file SELinux
                                // context = executable), bypassing extract_loader() which fails
                                // on Android 10+ due to W^X restriction on app_data_file context.
                                // Launch with -l (login shell) so Alpine's /etc/profile is sourced,
                                // setting correct PATH for all commands (apk, cat, ls, etc).
                                // Do NOT bind Android system binaries — they need bionic libc.
                                const cmd = `\x15mkdir -p "${tmpDir}" && export PROOT_TMP_DIR="${tmpDir}" && export PROOT_LOADER="${prootLoaderBin}" && "${prootBin}" -0 --rootfs="${rootfsPath}" --bind=/dev --bind=/proc --bind=/sys -w /root /bin/sh -l\n`;
                                term.write(cmd);
                            }, 600);
                        }
                    }
                }).catch(() => {/* ignore */ });
            }
        }

        // Cursor blink
        const blinkTimer = setInterval(() => setBlink((p) => !p), 500);

        // Adaptive poll timer
        let pollInterval = 100;
        const poll = () => {
            const timeSinceInput = Date.now() - lastInputRef.current;
            pollInterval = timeSinceInput < 2000 ? 80 : 400;

            const buffer = term.getBuffer();
            const sbResult = term.pullScrollback();

            // Parse scrollback
            if (sbResult?.buffer && sbResult.rowLengths) {
                const sbView = new Uint32Array(sbResult.buffer);
                let ptr = 0;
                const newRows: TextSpan[][] = [];
                for (const length of sbResult.rowLengths) {
                    newRows.push(parseCells(sbView, ptr, length));
                    ptr += length * 4;
                }
                if (newRows.length > 0) {
                    setHistoryData((prev) => [...prev, ...newRows]);
                }
            }

            // Parse screen
            if (buffer && buffer.byteLength > 0) {
                const view = new Uint32Array(buffer);
                const rows = term.getRows();
                const termCols = term.getCols();
                const newRowsData: TextSpan[][] = [];
                let idx = 0;
                for (let r = 0; r < rows; r++) {
                    newRowsData.push(parseCells(view, idx, termCols));
                    idx += termCols * 4;
                }
                setRowsData(newRowsData);
                setCursor({ x: term.getCursorX(), y: term.getCursorY() });
            }

            timerId = setTimeout(poll, pollInterval);
        };

        let timerId = setTimeout(poll, 100);

        return () => {
            clearTimeout(timerId);
            clearInterval(blinkTimer);
            // Keep PTY alive when tab switches (don't call stopPty here).
            // Parent can call stopPty() explicitly via ref if needed.
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // ── Resize on orientation change ──────────────
    useEffect(() => {
        const sub = Dimensions.addEventListener("change", ({ window }) => {
            const newCols = Math.floor((window.width - 20) / CHAR_WIDTH);
            setCols(newCols);
            termRef.current?.resize(24, newCols);
        });
        return () => sub.remove();
    }, []);

    // ── Key write helper ──────────────────────────
    const writeToTerm = useCallback((data: string) => {
        lastInputRef.current = Date.now();
        termRef.current?.write(data);
    }, []);

    // ── Render ────────────────────────────────────
    const allRows = useMemo(() => historyData.concat(rowsData), [historyData, rowsData]);

    // Still checking runtime status
    if (showSetup === null) {
        return (
            <View style={[styles.container, styles.center]}>
                <Text style={styles.checkingText}>正在检查运行时环境...</Text>
            </View>
        );
    }

    // Show setup wizard
    if (showSetup) {
        return <RuntimeSetup onComplete={() => setShowSetup(false)} />;
    }

    return (
        <View style={styles.container}>
            {/* Terminal canvas */}
            <TouchableOpacity
                activeOpacity={1}
                style={styles.termCanvas}
                onPress={() => inputRef.current?.focus()}
            >
                <FlatList
                    ref={flatListRef}
                    data={allRows}
                    keyExtractor={(_, idx) => idx.toString()}
                    contentContainerStyle={styles.termContent}
                    onContentSizeChange={() => flatListRef.current?.scrollToEnd({ animated: false })}
                    renderItem={({ item, index }) => {
                        const isCursorRow = index === historyData.length + cursor.y;
                        return (
                            <View style={styles.termRow}>
                                {item.map((span: TextSpan, sIdx: number) => {
                                    const fg = span.reverse ? span.bg : span.fg;
                                    const bg = span.reverse ? span.fg : span.bg;
                                    return (
                                        <Text
                                            key={sIdx}
                                            style={{
                                                fontFamily: Platform.OS === "ios" ? "Courier" : "monospace",
                                                color: fg,
                                                backgroundColor: bg === "#000000" ? "transparent" : bg,
                                                fontSize: FONT_SIZE,
                                                lineHeight: LINE_HEIGHT,
                                                fontWeight: span.bold ? "bold" : "normal",
                                                fontStyle: span.italic ? "italic" : "normal",
                                                textDecorationLine: span.underline ? "underline" : "none",
                                            }}
                                        >
                                            {span.text}
                                        </Text>
                                    );
                                })}
                                {/* Cursor */}
                                {isCursorRow && (
                                    <View
                                        style={[
                                            styles.cursor,
                                            {
                                                left: cursor.x * CHAR_WIDTH,
                                                opacity: blink ? 0.75 : 0,
                                            },
                                        ]}
                                    />
                                )}
                            </View>
                        );
                    }}
                />

                {/* Hidden keyboard input capture */}
                <TextInput
                    ref={inputRef}
                    autoFocus
                    autoCapitalize="none"
                    autoCorrect={false}
                    spellCheck={false}
                    textContentType="none"
                    keyboardType={
                        Platform.OS === "android" ? "visible-password" : "ascii-capable"
                    }
                    smartInsertDelete={false}
                    blurOnSubmit={false}
                    style={styles.hiddenInput}
                    onSubmitEditing={() => writeToTerm("\r")}
                    onKeyPress={(e) => {
                        const key = e.nativeEvent.key;
                        if (key === "Enter") writeToTerm("\r");
                        else if (key === "Backspace") writeToTerm("\x7f");
                    }}
                    onChangeText={(text) => {
                        const prev = (inputRef.current as any)._lastText || "";
                        if (text.length > prev.length) {
                            let added = text.slice(prev.length).replace(/\n/g, "");
                            if (added.length > 0) writeToTerm(added);
                        } else if (text.length < prev.length) {
                            const deleted = prev.length - text.length;
                            for (let i = 0; i < deleted; i++) writeToTerm("\x7f");
                        }
                        (inputRef.current as any)._lastText = text;
                    }}
                />
            </TouchableOpacity>

            {/* Keyboard special-key toolbar */}
            <KeyboardToolbar onKey={writeToTerm} />
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: "#000",
    },
    center: {
        alignItems: "center",
        justifyContent: "center",
    },
    checkingText: {
        color: "#8E8E93",
        fontSize: 14,
    },
    termCanvas: {
        flex: 1,
        position: "relative",
    },
    termContent: {
        padding: 10,
    },
    termRow: {
        flexDirection: "row",
        height: LINE_HEIGHT,
        position: "relative",
    },
    cursor: {
        position: "absolute",
        top: 0,
        width: CHAR_WIDTH,
        height: LINE_HEIGHT,
        backgroundColor: "#FFF",
    },
    hiddenInput: {
        position: "absolute",
        top: -100,
        left: -100,
        width: 1,
        height: 1,
    },
});
