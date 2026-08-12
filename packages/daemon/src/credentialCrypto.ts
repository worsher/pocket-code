import crypto from "crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import nacl from "tweetnacl";
import { SealedSecretEnvelope, type SealedSecretEnvelopeType } from "@pocket-code/wire";

const KEY_FILE = "credential-encryption-key.json";
const ENVELOPE_TTL_MS = 5 * 60 * 1000;
const MAX_CLOCK_SKEW_MS = 30 * 1000;

export interface DaemonCredentialKeyPair {
  publicKey: string;
  keyId: string;
  /** Kept in memory only after loading the mode-0600 key file. */
  secretKey: Uint8Array;
}

export type CredentialDecryptErrorCode =
  | "encryption_key_mismatch"
  | "decryption_failed"
  | "invalid_request";

export class CredentialDecryptError extends Error {
  constructor(
    public readonly code: CredentialDecryptErrorCode,
    message: string
  ) {
    super(message);
    this.name = "CredentialDecryptError";
  }
}

/** Load the stable daemon X25519 key or create it once with restrictive permissions. */
export function loadOrCreateCredentialKeyPair(pocketHome: string): DaemonCredentialKeyPair {
  const keyPath = join(pocketHome, KEY_FILE);
  try {
    const stored = JSON.parse(readFileSync(keyPath, "utf8")) as Record<string, unknown>;
    const secretKey = decodeBase64(String(stored.secretKey ?? ""));
    if (secretKey.length !== nacl.box.secretKeyLength) throw new Error("invalid secret key length");
    const derived = nacl.box.keyPair.fromSecretKey(secretKey);
    const publicKey = encodeBase64(derived.publicKey);
    const keyId = deriveKeyId(derived.publicKey);
    if (stored.publicKey !== publicKey || stored.keyId !== keyId || stored.version !== 1) {
      throw new Error("stored public key metadata does not match secret key");
    }
    chmodSync(keyPath, 0o600);
    return { publicKey, keyId, secretKey: derived.secretKey };
  } catch (error) {
    if (!isMissingFile(error)) {
      throw new Error(`Credential encryption key is invalid: ${(error as Error).message}`);
    }
  }

  mkdirSync(pocketHome, { recursive: true, mode: 0o700 });
  const secretKey = new Uint8Array(crypto.randomBytes(nacl.box.secretKeyLength));
  const keyPair = nacl.box.keyPair.fromSecretKey(secretKey);
  const publicKey = encodeBase64(keyPair.publicKey);
  const keyId = deriveKeyId(keyPair.publicKey);
  const tempPath = join(
    pocketHome,
    `.${KEY_FILE}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`
  );
  try {
    writeFileSync(
      tempPath,
      JSON.stringify({ version: 1, keyId, publicKey, secretKey: encodeBase64(keyPair.secretKey) }),
      { mode: 0o600, flag: "wx" }
    );
    renameSync(tempPath, keyPath);
    chmodSync(keyPath, 0o600);
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch {
      // Best-effort cleanup of this process-owned temp file.
    }
    throw error;
  } finally {
    secretKey.fill(0);
  }
  return { publicKey, keyId, secretKey: keyPair.secretKey };
}

/** Authenticated decryptor with profile binding, freshness and replay protection. */
export class CredentialEnvelopeDecryptor {
  private readonly seenNonces = new Map<string, number>();

  constructor(
    private readonly keyPair: DaemonCredentialKeyPair,
    private readonly now: () => number = Date.now
  ) {}

  open(
    rawEnvelope: unknown,
    expected: { profileId: string; origin: string; requestId: string }
  ): string {
    const parsed = SealedSecretEnvelope.safeParse(rawEnvelope);
    if (!parsed.success) {
      throw new CredentialDecryptError("invalid_request", "Invalid encrypted credential envelope");
    }
    const envelope = parsed.data;
    if (envelope.keyId !== this.keyPair.keyId) {
      throw new CredentialDecryptError(
        "encryption_key_mismatch",
        "Credential was encrypted for a different daemon key; pair again"
      );
    }
    if (envelope.profileId !== expected.profileId || envelope.origin !== expected.origin) {
      throw new CredentialDecryptError(
        "invalid_request",
        "Encrypted credential does not match the requested profile"
      );
    }
    if (envelope.requestId !== expected.requestId) {
      throw new CredentialDecryptError(
        "invalid_request",
        "Encrypted credential does not match the request id"
      );
    }

    const now = this.now();
    if (envelope.issuedAt > now + MAX_CLOCK_SKEW_MS || now - envelope.issuedAt > ENVELOPE_TTL_MS) {
      throw new CredentialDecryptError("invalid_request", "Encrypted credential envelope expired");
    }
    this.removeExpiredNonces(now);
    const replayKey = `${envelope.keyId}:${envelope.bindingNonce}`;
    if (this.seenNonces.has(replayKey)) {
      throw new CredentialDecryptError("invalid_request", "Encrypted credential envelope was replayed");
    }

    const plaintext = openBox(envelope, this.keyPair.secretKey);
    let decoded: unknown;
    try {
      decoded = JSON.parse(Buffer.from(plaintext).toString("utf8"));
    } catch {
      plaintext.fill(0);
      throw new CredentialDecryptError("decryption_failed", "Encrypted credential payload is invalid");
    }

    try {
      if (!isBoundPayload(decoded, envelope)) {
        throw new CredentialDecryptError(
          "decryption_failed",
          "Encrypted credential binding metadata was modified"
        );
      }
      if (!decoded.secret || decoded.secret.length > 16_384) {
        throw new CredentialDecryptError("decryption_failed", "Encrypted credential secret is invalid");
      }
      this.seenNonces.set(replayKey, now + ENVELOPE_TTL_MS);
      return decoded.secret;
    } finally {
      plaintext.fill(0);
    }
  }

  private removeExpiredNonces(now: number): void {
    for (const [nonce, expiresAt] of this.seenNonces) {
      if (expiresAt <= now) this.seenNonces.delete(nonce);
    }
  }
}

function openBox(envelope: SealedSecretEnvelopeType, secretKey: Uint8Array): Uint8Array {
  let ciphertext: Uint8Array;
  let nonce: Uint8Array;
  let ephemeralPublicKey: Uint8Array;
  try {
    ciphertext = decodeBase64(envelope.ciphertext);
    nonce = decodeBase64(envelope.nonce);
    ephemeralPublicKey = decodeBase64(envelope.ephemeralPublicKey);
  } catch {
    throw new CredentialDecryptError("decryption_failed", "Encrypted credential encoding is invalid");
  }
  if (
    nonce.length !== nacl.box.nonceLength ||
    ephemeralPublicKey.length !== nacl.box.publicKeyLength
  ) {
    throw new CredentialDecryptError("decryption_failed", "Encrypted credential key material is invalid");
  }
  const plaintext = nacl.box.open(ciphertext, nonce, ephemeralPublicKey, secretKey);
  if (plaintext === false) {
    throw new CredentialDecryptError("decryption_failed", "Encrypted credential authentication failed");
  }
  return plaintext;
}

function isBoundPayload(
  value: unknown,
  envelope: SealedSecretEnvelopeType
): value is {
  secret: string;
  profileId: string;
  origin: string;
  issuedAt: number;
  nonce: string;
  requestId?: string;
} {
  if (!value || typeof value !== "object") return false;
  const payload = value as Record<string, unknown>;
  return (
    payload.profileId === envelope.profileId &&
    payload.origin === envelope.origin &&
    payload.issuedAt === envelope.issuedAt &&
    payload.nonce === envelope.bindingNonce &&
    payload.requestId === envelope.requestId &&
    typeof payload.secret === "string"
  );
}

function deriveKeyId(publicKey: Uint8Array): string {
  return `x25519_${crypto.createHash("sha256").update(publicKey).digest("hex").slice(0, 32)}`;
}

function encodeBase64(value: Uint8Array): string {
  return Buffer.from(value).toString("base64");
}

function decodeBase64(value: string): Uint8Array {
  if (!value || value.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new Error("invalid base64");
  }
  return new Uint8Array(Buffer.from(value, "base64"));
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT");
}
