import { describe, expect, it } from "vitest";
import nacl from "tweetnacl";
import { sealCredentialSecret } from "./credentialCrypto";

function deterministicRandom() {
  let counter = 1;
  return (length: number) => {
    const bytes = new Uint8Array(length);
    for (let index = 0; index < length; index++) bytes[index] = counter++ & 0xff;
    return bytes;
  };
}

function decode(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64"));
}

describe("credential secret sealing", () => {
  it("round-trips a UTF-8 secret with a daemon X25519 key", () => {
    const daemonSecretKey = Uint8Array.from({ length: 32 }, (_, index) => index + 31);
    const daemonKeyPair = nacl.box.keyPair.fromSecretKey(daemonSecretKey);
    const envelope = sealCredentialSecret(
      {
        secret: "github_pat_秘密-token",
        profile: { id: "github-main", origin: "https://github.com" },
        requestId: "cred-1",
      },
      {
        keyId: "daemon-key-1",
        publicKey: Buffer.from(daemonKeyPair.publicKey).toString("base64"),
      },
      { randomBytes: deterministicRandom(), now: () => 123_000 }
    );

    const plaintext = nacl.box.open(
      decode(envelope.ciphertext),
      decode(envelope.nonce),
      decode(envelope.ephemeralPublicKey),
      daemonKeyPair.secretKey
    );
    expect(plaintext).not.toBe(false);
    expect(JSON.parse(Buffer.from(plaintext as Uint8Array).toString("utf8"))).toEqual({
      secret: "github_pat_秘密-token",
      profileId: "github-main",
      origin: "https://github.com",
      issuedAt: 123_000,
      nonce: envelope.bindingNonce,
      requestId: "cred-1",
    });
  });

  it("fails authentication when ciphertext is tampered", () => {
    const daemonSecretKey = Uint8Array.from({ length: 32 }, (_, index) => 255 - index);
    const daemonKeyPair = nacl.box.keyPair.fromSecretKey(daemonSecretKey);
    const envelope = sealCredentialSecret(
      {
        secret: "gitee-token",
        profile: { id: "gitee-main", origin: "https://gitee.com" },
        requestId: "cred-2",
      },
      {
        keyId: "daemon-key-2",
        publicKey: Buffer.from(daemonKeyPair.publicKey).toString("base64"),
      },
      { randomBytes: deterministicRandom() }
    );
    const ciphertext = decode(envelope.ciphertext);
    ciphertext[0] ^= 1;

    expect(
      nacl.box.open(
        ciphertext,
        decode(envelope.nonce),
        decode(envelope.ephemeralPublicKey),
        daemonKeyPair.secretKey
      )
    ).toBe(false);
  });

  it("rejects malformed daemon keys and insecure random sources", () => {
    expect(() =>
      sealCredentialSecret(
        {
          secret: "token",
          profile: { id: "p", origin: "https://github.com" },
          requestId: "cred-3",
        },
        { keyId: "k", publicKey: "not-base64" },
        { randomBytes: deterministicRandom() }
      )
    ).toThrow("base64");
    const validPublicKey = Buffer.alloc(32, 1).toString("base64");
    expect(() =>
      sealCredentialSecret(
        {
          secret: "token",
          profile: { id: "p", origin: "https://github.com" },
          requestId: "cred-4",
        },
        { keyId: "k", publicKey: validPublicKey },
        { randomBytes: () => new Uint8Array(1) }
      )
    ).toThrow("expected 32");
  });
});
