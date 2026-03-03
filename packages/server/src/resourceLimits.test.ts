import { describe, it, expect } from "vitest";
import { checkQuota, getUserQuota, incrementUsage, TIER_LIMITS } from "./resourceLimits.js";

// These tests use the actual DB functions, so we need to initialize the database.
// We import initDb and run it before all tests.
import { initDb } from "./db.js";
import { beforeAll } from "vitest";

beforeAll(async () => {
    // Use an in-memory / temp database for testing
    process.env.DB_PATH = "/tmp/pocket-code-test-" + Date.now() + ".db";
    await initDb();
});

describe("resourceLimits", () => {
    const testUserId = "test_user_" + Date.now();

    it("should create free-tier quota for new user", () => {
        const quota = getUserQuota(testUserId);
        expect(quota.tier).toBe("free");
        expect(quota.limits).toEqual(TIER_LIMITS.free);
        expect(quota.usage.dailyApiCallsUsed).toBe(0);
    });

    it("should allow API call within limit", () => {
        const result = checkQuota(testUserId, "api_call");
        expect(result.allowed).toBe(true);
    });

    it("should increment API call usage", () => {
        incrementUsage(testUserId, "api_call");
        const quota = getUserQuota(testUserId);
        expect(quota.usage.dailyApiCallsUsed).toBe(1);
    });

    it("should block API calls when limit is reached", () => {
        const userId = "limit_test_user_" + Date.now();
        // Exhaust daily limit
        for (let i = 0; i < TIER_LIMITS.free.dailyApiCalls; i++) {
            incrementUsage(userId, "api_call");
        }
        const result = checkQuota(userId, "api_call");
        expect(result.allowed).toBe(false);
        expect(result.reason).toContain("Daily API call limit reached");
    });

    it("should have correct tier limits", () => {
        expect(TIER_LIMITS.free.dailyApiCalls).toBe(50);
        expect(TIER_LIMITS.basic.dailyApiCalls).toBe(500);
        expect(TIER_LIMITS.pro.dailyApiCalls).toBe(5000);
        expect(TIER_LIMITS.pro.memoryMB).toBe(1024);
    });
});
