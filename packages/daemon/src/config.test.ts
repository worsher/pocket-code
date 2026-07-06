import { describe, it, expect } from "vitest";
import { requireRelaySecret } from "./config.js";

describe("requireRelaySecret (daemon)", () => {
  it("returns the secret when set", () => {
    expect(requireRelaySecret({ RELAY_SECRET: "s3cret" })).toBe("s3cret");
  });
  it("throws with guidance when missing or blank", () => {
    expect(() => requireRelaySecret({})).toThrow(/openssl rand -hex 32/);
    expect(() => requireRelaySecret({ RELAY_SECRET: "" })).toThrow(/RELAY_SECRET/);
  });
});
