import { describe, it, expect } from "vitest";
import { WsMessage } from "./wsSchemas.js";

describe("wsSchemas — WsMessage validation", () => {
    // ── Valid messages ──

    it("should accept valid register message", () => {
        const result = WsMessage.safeParse({ type: "register", deviceId: "abc123" });
        expect(result.success).toBe(true);
    });

    it("should accept valid init message", () => {
        const result = WsMessage.safeParse({
            type: "init",
            token: "jwt-token",
            sessionId: "sess-1",
            model: "deepseek-v3",
        });
        expect(result.success).toBe(true);
    });

    it("should accept valid message with images", () => {
        const result = WsMessage.safeParse({
            type: "message",
            content: "analyze this",
            images: [{ base64: "abc", mimeType: "image/png" }],
        });
        expect(result.success).toBe(true);
    });

    it("should accept valid abort message", () => {
        const result = WsMessage.safeParse({ type: "abort" });
        expect(result.success).toBe(true);
    });

    it("should accept valid tool-exec message", () => {
        const result = WsMessage.safeParse({
            type: "tool-exec",
            toolName: "readFile",
            args: { path: "test.txt" },
            callId: "call-1",
        });
        expect(result.success).toBe(true);
    });

    // ── Invalid messages ──

    it("should reject unknown message type", () => {
        const result = WsMessage.safeParse({ type: "unknown-type" });
        expect(result.success).toBe(false);
    });

    it("should reject register without deviceId", () => {
        const result = WsMessage.safeParse({ type: "register" });
        expect(result.success).toBe(false);
    });

    it("should reject register with empty deviceId", () => {
        const result = WsMessage.safeParse({ type: "register", deviceId: "" });
        expect(result.success).toBe(false);
    });

    it("should reject message without content", () => {
        const result = WsMessage.safeParse({ type: "message" });
        expect(result.success).toBe(false);
    });

    it("should reject message with empty content", () => {
        const result = WsMessage.safeParse({ type: "message", content: "" });
        expect(result.success).toBe(false);
    });

    it("should reject message with too many images", () => {
        const images = Array.from({ length: 11 }, () => ({
            base64: "abc",
            mimeType: "image/png",
        }));
        const result = WsMessage.safeParse({
            type: "message",
            content: "test",
            images,
        });
        expect(result.success).toBe(false);
    });

    it("should reject tool-exec without toolName", () => {
        const result = WsMessage.safeParse({
            type: "tool-exec",
            args: {},
        });
        expect(result.success).toBe(false);
    });

    it("should reject non-object input", () => {
        const result = WsMessage.safeParse("not an object");
        expect(result.success).toBe(false);
    });

    it("should reject null input", () => {
        const result = WsMessage.safeParse(null);
        expect(result.success).toBe(false);
    });
});
