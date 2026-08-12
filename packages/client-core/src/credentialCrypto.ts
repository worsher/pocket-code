import nacl from "tweetnacl";
import type { SealedSecretEnvelopeType } from "@pocket-code/wire";

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export interface DaemonEncryptionKey {
  publicKey: string;
  keyId: string;
}

export type SecureRandomBytes = (length: number) => Uint8Array;

export interface CredentialSecretInput {
  secret: string;
  profile: { id: string; origin: string };
  requestId: string;
}

export interface SealCredentialOptions {
  randomBytes?: SecureRandomBytes;
  now?: () => number;
}

/** Seal a credential so only the paired daemon key can open it. */
export function sealCredentialSecret(
  input: CredentialSecretInput,
  recipient: DaemonEncryptionKey,
  options: SealCredentialOptions = {}
): SealedSecretEnvelopeType {
  const { secret, profile, requestId } = input;
  const randomBytes = options.randomBytes ?? defaultSecureRandomBytes;
  if (!secret || secret.length > 16_384) {
    throw new Error("Credential secret must be between 1 and 16384 characters");
  }
  if (!recipient.keyId || recipient.keyId.length > 128) {
    throw new Error("Invalid daemon encryption key id");
  }
  if (!profile.id || profile.id.length > 128 || !profile.origin || profile.origin.length > 2048) {
    throw new Error("Invalid credential profile binding");
  }
  if (!requestId || requestId.length > 128) throw new Error("Invalid credential request id");

  const recipientPublicKey = base64ToBytes(recipient.publicKey);
  if (recipientPublicKey.length !== nacl.box.publicKeyLength) {
    throw new Error("Invalid daemon encryption public key");
  }

  const ephemeralSecretKey = copyRandomBytes(randomBytes, nacl.box.secretKeyLength);
  const nonce = copyRandomBytes(randomBytes, nacl.box.nonceLength);
  const bindingNonce = bytesToBase64(copyRandomBytes(randomBytes, 16));
  const issuedAt = (options.now ?? Date.now)();
  const ephemeralKeyPair = nacl.box.keyPair.fromSecretKey(ephemeralSecretKey);
  const plaintext = utf8ToBytes(
    JSON.stringify({
      secret,
      profileId: profile.id,
      origin: profile.origin,
      issuedAt,
      nonce: bindingNonce,
      requestId,
    })
  );
  try {
    const ciphertext = nacl.box(
      plaintext,
      nonce,
      recipientPublicKey,
      ephemeralKeyPair.secretKey
    );
    return {
      version: 1,
      algorithm: "x25519-xsalsa20-poly1305",
      keyId: recipient.keyId,
      profileId: profile.id,
      origin: profile.origin,
      issuedAt,
      bindingNonce,
      requestId,
      ephemeralPublicKey: bytesToBase64(ephemeralKeyPair.publicKey),
      nonce: bytesToBase64(nonce),
      ciphertext: bytesToBase64(ciphertext),
    };
  } finally {
    plaintext.fill(0);
    ephemeralSecretKey.fill(0);
    ephemeralKeyPair.secretKey.fill(0);
  }
}

function copyRandomBytes(randomBytes: SecureRandomBytes, length: number): Uint8Array {
  const value = randomBytes(length);
  if (!(value instanceof Uint8Array) || value.length !== length) {
    throw new Error(`Secure random source returned ${value?.length ?? "invalid"} bytes; expected ${length}`);
  }
  return new Uint8Array(value);
}

function defaultSecureRandomBytes(length: number): Uint8Array {
  const cryptoApi = (globalThis as { crypto?: { getRandomValues?: (value: Uint8Array) => Uint8Array } })
    .crypto;
  if (cryptoApi?.getRandomValues) {
    return cryptoApi.getRandomValues(new Uint8Array(length));
  }
  try {
    return nacl.randomBytes(length);
  } catch {
    throw new Error(
      "No secure random source is available; pass expo-crypto getRandomBytes to sealCredentialSecret"
    );
  }
}

function utf8ToBytes(value: string): Uint8Array {
  if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(value);

  const bytes: number[] = [];
  for (let index = 0; index < value.length; index++) {
    let point = value.charCodeAt(index);
    if (point >= 0xd800 && point <= 0xdbff && index + 1 < value.length) {
      const low = value.charCodeAt(index + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        point = 0x10000 + ((point - 0xd800) << 10) + (low - 0xdc00);
        index++;
      }
    }
    if (point <= 0x7f) bytes.push(point);
    else if (point <= 0x7ff) bytes.push(0xc0 | (point >> 6), 0x80 | (point & 0x3f));
    else if (point <= 0xffff) {
      bytes.push(0xe0 | (point >> 12), 0x80 | ((point >> 6) & 0x3f), 0x80 | (point & 0x3f));
    } else {
      bytes.push(
        0xf0 | (point >> 18),
        0x80 | ((point >> 12) & 0x3f),
        0x80 | ((point >> 6) & 0x3f),
        0x80 | (point & 0x3f)
      );
    }
  }
  return Uint8Array.from(bytes);
}

function bytesToBase64(bytes: Uint8Array): string {
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index];
    const hasB = index + 1 < bytes.length;
    const hasC = index + 2 < bytes.length;
    const b = hasB ? bytes[index + 1] : 0;
    const c = hasC ? bytes[index + 2] : 0;
    output += BASE64_ALPHABET[a >> 2];
    output += BASE64_ALPHABET[((a & 3) << 4) | (b >> 4)];
    output += hasB ? BASE64_ALPHABET[((b & 15) << 2) | (c >> 6)] : "=";
    output += hasC ? BASE64_ALPHABET[c & 63] : "=";
  }
  return output;
}

function base64ToBytes(value: string): Uint8Array {
  if (!value || value.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new Error("Invalid base64 value");
  }
  const clean = value.replace(/=+$/, "");
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of clean) {
    const digit = BASE64_ALPHABET.indexOf(char);
    if (digit < 0) throw new Error("Invalid base64 value");
    buffer = (buffer << 6) | digit;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return Uint8Array.from(bytes);
}
