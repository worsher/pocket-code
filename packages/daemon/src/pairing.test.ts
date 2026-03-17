import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  generatePairingCode,
  verifyPairingCode,
  verifyDeviceToken,
  getPairingCodeInfo,
} from "./pairing.js";
import { revokeDevice } from "./deviceStore.js";
import jwt from "jsonwebtoken";

describe("Daemon Pairing & Security", () => {
  const MACHINE_ID = "m_test123";

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should generate a 6-digit pairing code", () => {
    const code = generatePairingCode();
    expect(code).toMatch(/^\d{6}$/);
    
    const info = getPairingCodeInfo();
    expect(info).not.toBeNull();
    expect(info?.code).toBe(code);
    expect(info?.used).toBe(false);
  });

  it("should fail validation with an incorrect code", () => {
    generatePairingCode();
    const result = verifyPairingCode("000000", "dev_1", "My iPhone", MACHINE_ID);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Invalid pairing code");
    }
  });

  it("should succeed validation with correct code and issue JWT", () => {
    const code = generatePairingCode();
    const result = verifyPairingCode(code, "dev_1", "My iPhone", MACHINE_ID);
    
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.token).toBeTypeOf("string");
      
      // Verify the generated token
      const decoded = verifyDeviceToken(result.token);
      expect(decoded).not.toBeNull();
      expect(decoded?.deviceId).toBe("dev_1");
      expect(decoded?.deviceName).toBe("My iPhone");
      expect(decoded?.machineId).toBe(MACHINE_ID);
    }
  });

  it("should reject reuse of a pairing code", () => {
    const code = generatePairingCode();
    
    // First use succeeds
    const res1 = verifyPairingCode(code, "dev_2", "iPad", MACHINE_ID);
    expect(res1.success).toBe(true);
    
    // Second use fails
    const res2 = verifyPairingCode(code, "dev_3", "MacBook", MACHINE_ID);
    expect(res2.success).toBe(false);
    if (!res2.success) {
      expect(res2.error).toContain("already been used");
    }
  });

  it("should expire pairing codes after 5 minutes", () => {
    const code = generatePairingCode();
    
    // Fast-forward 5 minutes and 1 millisecond
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);
    
    const result = verifyPairingCode(code, "dev_x", "Device X", MACHINE_ID);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("expired");
    }
    
    expect(getPairingCodeInfo()).toBeNull();
  });

  it("should reject device tokens after revocation", () => {
    const code = generatePairingCode();
    const result = verifyPairingCode(code, "dev_revoked", "Bad Phone", MACHINE_ID);
    expect(result.success).toBe(true);
    
    if (result.success) {
      const token = result.token;
      
      // Valid initially
      expect(verifyDeviceToken(token)).not.toBeNull();
      
      // Revoke the device
      revokeDevice("dev_revoked");
      
      // Invalid after revocation
      expect(verifyDeviceToken(token)).toBeNull();
    }
  });

  it("should reject forged JWTs", () => {
    const forgedToken = jwt.sign(
      { deviceId: "hacker", deviceName: "Evil", machineId: MACHINE_ID },
      "not-the-real-secret"
    );
    
    expect(verifyDeviceToken(forgedToken)).toBeNull();
  });
});
