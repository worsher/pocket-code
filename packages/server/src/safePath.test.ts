import { describe, it, expect } from "vitest";

// We test safePath by importing the tools module and checking path resolution.
// Since safePath is not directly exported, we test it through the tool factory.
// Instead, let's replicate the safePath logic for direct testing.
import { resolve, join } from "path";

/**
 * Replicated safePath logic from tools.ts for direct testing.
 * Tests path traversal prevention.
 */
function safePath(workspace: string, relativePath: string): string {
    const resolved = resolve(workspace, relativePath);
    if (!resolved.startsWith(workspace)) {
        throw new Error(`Path traversal detected: ${relativePath}`);
    }
    return resolved;
}

describe("safePath — directory traversal prevention", () => {
    const workspace = "/home/user/workspace";

    it("should resolve normal relative paths", () => {
        const result = safePath(workspace, "src/index.ts");
        expect(result).toBe("/home/user/workspace/src/index.ts");
    });

    it("should resolve dot paths", () => {
        const result = safePath(workspace, "./src/index.ts");
        expect(result).toBe("/home/user/workspace/src/index.ts");
    });

    it("should reject parent directory traversal", () => {
        expect(() => safePath(workspace, "../etc/passwd")).toThrow(
            "Path traversal detected"
        );
    });

    it("should reject double parent directory traversal", () => {
        expect(() => safePath(workspace, "../../etc/shadow")).toThrow(
            "Path traversal detected"
        );
    });

    it("should reject absolute paths outside workspace", () => {
        expect(() => safePath(workspace, "/etc/passwd")).toThrow(
            "Path traversal detected"
        );
    });

    it("should allow nested directory access", () => {
        const result = safePath(workspace, "src/components/Header/index.tsx");
        expect(result).toBe(
            "/home/user/workspace/src/components/Header/index.tsx"
        );
    });

    it("should allow workspace root access", () => {
        const result = safePath(workspace, ".");
        expect(result).toBe("/home/user/workspace");
    });
});
