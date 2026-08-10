import { describe, expect, it } from "vitest";
import { sanitizeGitRemoteUrl } from "./gitUrl";

describe("sanitizeGitRemoteUrl", () => {
  it("removes embedded credentials without changing the remote path", () => {
    expect(
      sanitizeGitRemoteUrl("  https://user:secret@example.com/acme/demo.git?depth=1#main  ")
    ).toBe("https://example.com/acme/demo.git?depth=1#main");
  });

  it("leaves credential-free and local remotes unchanged", () => {
    expect(sanitizeGitRemoteUrl("https://example.com/acme/demo.git")).toBe(
      "https://example.com/acme/demo.git"
    );
    expect(sanitizeGitRemoteUrl("../demo.git")).toBe("../demo.git");
  });
});
