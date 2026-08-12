import { describe, expect, it } from "vitest";
import {
  createGitCredentialOnAuth,
  gitCredentialProfileMatchesUrl,
  matchingGitCredentialProfiles,
  normalizeGitCredentialOrigin,
  normalizeGitCredentialProfile,
  normalizeGitRemoteHttpsUrl,
  resolveGitCredentialProfile,
  secretRefForGitCredentialProfile,
  toGitCredentialWireProfile,
  type GitCredentialProfile,
} from "./gitCredentialProfiles";

function profile(overrides: Partial<GitCredentialProfile> = {}): GitCredentialProfile {
  return {
    id: "company-gitlab",
    label: "Company GitLab",
    provider: "gitlab",
    authKind: "pat",
    origin: "https://gitlab.example.com:8443",
    username: "developer",
    pathPrefix: "/gitlab/team-a",
    secretRef: secretRefForGitCredentialProfile("company-gitlab"),
    hasSecret: true,
    ...overrides,
  };
}

describe("Git credential profile URL boundaries", () => {
  it("matches an exact HTTPS origin, port, and path boundary", () => {
    const value = profile();
    expect(
      gitCredentialProfileMatchesUrl(
        value,
        "https://gitlab.example.com:8443/gitlab/team-a/repo.git"
      )
    ).toBe(true);
    expect(
      gitCredentialProfileMatchesUrl(
        value,
        "https://gitlab.example.com/gitlab/team-a/repo.git"
      )
    ).toBe(false);
    expect(
      gitCredentialProfileMatchesUrl(
        value,
        "https://gitlab.example.com:8443/gitlab/team-ab/repo.git"
      )
    ).toBe(false);
  });

  it("prefers the most specific configured path", () => {
    const broad = profile({ id: "broad", pathPrefix: "/gitlab", secretRef: "ignored" });
    const narrow = profile({ id: "narrow", secretRef: "ignored" });
    expect(
      matchingGitCredentialProfiles(
        "https://gitlab.example.com:8443/gitlab/team-a/repo.git",
        [broad, narrow]
      ).map((entry) => entry.id)
    ).toEqual(["narrow", "broad"]);
  });

  it("rejects HTTP and embedded credentials", () => {
    expect(() => normalizeGitCredentialOrigin("http://gitlab.example.com")).toThrow("HTTPS");
    expect(() => normalizeGitRemoteHttpsUrl("https://user:token@github.com/o/r.git")).toThrow(
      "must not contain"
    );
  });

  it.each([
    "https://github.com/acme/%2e%2e/private.git",
    "https://github.com/acme/%252e%252e/private.git",
    "https://github.com/acme%2fprivate/repo.git",
    "https://github.com/acme%5cprivate/repo.git",
  ])("rejects ambiguous encoded remote paths: %s", (remote) => {
    expect(() => normalizeGitRemoteHttpsUrl(remote)).toThrow(/path|separator/i);
  });

  it("rejects ambiguous or encoded path traversal and separators", () => {
    for (const url of [
      "https://github.com/org/../repo.git",
      "https://github.com/org/%2e%2e/repo.git",
      "https://github.com/org%2Frepo.git",
      "https://github.com/org%5Crepo.git",
      "https://github.com/org/%00repo.git",
      "https://github.com/org\\repo.git",
    ]) {
      expect(() => normalizeGitRemoteHttpsUrl(url), url).toThrow();
    }
    expect(() => normalizeGitRemoteHttpsUrl("https://github.com/")).toThrow(
      "requires a repository path"
    );
  });

  it("rejects an explicitly selected profile outside its boundary", () => {
    expect(() =>
      resolveGitCredentialProfile(
        "https://gitlab.example.com:8443/other/repo.git",
        [profile()],
        "company-gitlab"
      )
    ).toThrow("not allowed");
  });

  it("rejects control characters in credential usernames", () => {
    expect(() => normalizeGitCredentialProfile(profile({ username: "user\0name" }))).toThrow(
      "username"
    );
  });

  it("never forwards the Key after a cross-origin redirect", () => {
    const onAuth = createGitCredentialOnAuth(profile(), "sentinel-secret");
    expect(onAuth("https://gitlab.example.com:8443/gitlab/team-a/repo.git")).toEqual({
      username: "developer",
      password: "sentinel-secret",
    });
    expect(onAuth("https://evil.example/gitlab/team-a/repo.git")).toEqual({ cancel: true });
  });

  it("wire metadata never contains secret state or secretRef", () => {
    const wire = toGitCredentialWireProfile(profile());
    expect(wire).toEqual({
      id: "company-gitlab",
      label: "Company GitLab",
      provider: "gitlab",
      authKind: "pat",
      origin: "https://gitlab.example.com:8443",
      username: "developer",
      pathPrefix: "/gitlab/team-a",
    });
    expect(JSON.stringify(wire)).not.toContain("secret");
  });
});
