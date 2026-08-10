import { describe, expect, it } from "vitest";
import {
  createProjectId,
  createReplicaId,
  isUuid,
  parseLegacyProjectId,
  parseProjectId,
} from "./ids.js";

const PROJECT_UUID = "018f00d2-8931-7bc0-aad1-1ec83b13f982";
const REPLICA_UUID = "550e8400-e29b-41d4-a716-446655440000";

describe("workspace IDs", () => {
  it("accepts UUID project and replica IDs and normalizes case", () => {
    expect(parseProjectId(PROJECT_UUID.toUpperCase())).toBe(PROJECT_UUID);
    expect(createReplicaId(() => REPLICA_UUID)).toBe(REPLICA_UUID);
    expect(isUuid(PROJECT_UUID)).toBe(true);
  });

  it("uses an injected UUID factory so mobile can create IDs offline", () => {
    expect(createProjectId(() => PROJECT_UUID)).toBe(PROJECT_UUID);
  });

  it("rejects names and path fragments as new project IDs", () => {
    expect(() => parseProjectId("default")).toThrow("UUID");
    expect(() => parseProjectId("../../outside")).toThrow("UUID");
    expect(() => parseProjectId("project-from-phone")).toThrow("UUID");
  });

  it("keeps legacy IDs in a separate migration-only type", () => {
    expect(parseLegacyProjectId("default")).toBe("default");
    expect(parseLegacyProjectId("proj_123:mobile")).toBe("proj_123:mobile");
    expect(() => parseLegacyProjectId("../default")).toThrow("legacy project ID");
    expect(() => parseLegacyProjectId("a/b")).toThrow("legacy project ID");
  });
});
