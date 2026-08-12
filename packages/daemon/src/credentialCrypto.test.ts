import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import nacl from "tweetnacl";
import type { SealedSecretEnvelopeType } from "@pocket-code/wire";
import {
  CredentialDecryptError,
  CredentialEnvelopeDecryptor,
  loadOrCreateCredentialKeyPair,
  type DaemonCredentialKeyPair,
} from "./credentialCrypto";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "pocket-daemon-crypto-"));
  tempDirs.push(dir);
  return dir;
}

function seal(
  daemon: DaemonCredentialKeyPair,
  input: {
    secret?: string;
    profileId?: string;
    origin?: string;
    issuedAt?: number;
    bindingNonce?: string;
    requestId?: string;
  } = {}
): SealedSecretEnvelopeType {
  const profileId = input.profileId ?? "github-main";
  const origin = input.origin ?? "https://github.com";
  const issuedAt = input.issuedAt ?? 100_000;
  const bindingNonce = input.bindingNonce ?? "nonce-1";
  const requestId = input.requestId ?? "cred-1";
  const ephemeralSecret = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
  const ephemeral = nacl.box.keyPair.fromSecretKey(ephemeralSecret);
  const nonce = Uint8Array.from({ length: 24 }, (_, index) => index + 61);
  const plaintext = Buffer.from(
    JSON.stringify({
      secret: input.secret ?? "github_pat_secret",
      profileId,
      origin,
      issuedAt,
      nonce: bindingNonce,
      requestId,
    }),
    "utf8"
  );
  const ciphertext = nacl.box(plaintext, nonce, new Uint8Array(Buffer.from(daemon.publicKey, "base64")), ephemeral.secretKey);
  return {
    version: 1,
    algorithm: "x25519-xsalsa20-poly1305",
    keyId: daemon.keyId,
    profileId,
    origin,
    issuedAt,
    bindingNonce,
    requestId,
    ephemeralPublicKey: Buffer.from(ephemeral.publicKey).toString("base64"),
    nonce: Buffer.from(nonce).toString("base64"),
    ciphertext: Buffer.from(ciphertext).toString("base64"),
  };
}

describe("daemon credential encryption", () => {
  it("persists one stable mode-0600 X25519 key pair", () => {
    const home = tempHome();
    const first = loadOrCreateCredentialKeyPair(home);
    const second = loadOrCreateCredentialKeyPair(home);
    expect(second.keyId).toBe(first.keyId);
    expect(second.publicKey).toBe(first.publicKey);
    expect(statSync(join(home, "credential-encryption-key.json")).mode & 0o777).toBe(0o600);
    const stored = readFileSync(join(home, "credential-encryption-key.json"), "utf8");
    expect(stored).not.toContain("github_pat");
  });

  it("decrypts once and rejects replay of the authenticated nonce", () => {
    const key = loadOrCreateCredentialKeyPair(tempHome());
    const decryptor = new CredentialEnvelopeDecryptor(key, () => 100_100);
    const envelope = seal(key);
    expect(
      decryptor.open(envelope, {
        profileId: "github-main",
        origin: "https://github.com",
        requestId: "cred-1",
      })
    ).toBe("github_pat_secret");
    expect(() =>
      decryptor.open(envelope, {
        profileId: "github-main",
        origin: "https://github.com",
        requestId: "cred-1",
      })
    ).toThrow("replayed");
  });

  it("rejects profile substitution, expiry, and ciphertext tampering", () => {
    const key = loadOrCreateCredentialKeyPair(tempHome());
    const decryptor = new CredentialEnvelopeDecryptor(key, () => 500_001);
    const envelope = seal(key, { issuedAt: 100_000 });
    expect(() =>
      decryptor.open(envelope, {
        profileId: "attacker-profile",
        origin: "https://evil.example",
        requestId: "cred-1",
      })
    ).toThrow("does not match");
    expect(() =>
      decryptor.open(envelope, {
        profileId: "github-main",
        origin: "https://github.com",
        requestId: "cred-1",
      })
    ).toThrow("expired");

    const freshDecryptor = new CredentialEnvelopeDecryptor(key, () => 100_100);
    const fresh = seal(key, { bindingNonce: "nonce-tamper" });
    const ciphertext = Buffer.from(fresh.ciphertext, "base64");
    ciphertext[0] ^= 1;
    const tampered = { ...fresh, ciphertext: ciphertext.toString("base64") };
    try {
      freshDecryptor.open(tampered, {
        profileId: "github-main",
        origin: "https://github.com",
        requestId: "cred-1",
      });
      throw new Error("expected decryption to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(CredentialDecryptError);
      expect((error as CredentialDecryptError).code).toBe("decryption_failed");
    }
  });
});
