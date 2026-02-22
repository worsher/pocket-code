// ── Resource Limits (按用户配额管理) ──────────────────────

import { getQuotaRecord, upsertQuotaRecord } from "./db.js";

export interface ResourceLimits {
  memoryMB: number;
  cpuCores: number;
  diskMB: number;
  maxSessions: number;
  maxContainerTimeSec: number;
  dailyApiCalls: number;
}

export interface ResourceUsage {
  dailyApiCallsUsed: number;
  totalContainerTimeSec: number;
  diskUsageMB: number;
  lastResetDate: string; // YYYY-MM-DD
}

export type UserTier = "free" | "basic" | "pro";

export interface UserQuota {
  userId: string;
  tier: UserTier;
  limits: ResourceLimits;
  usage: ResourceUsage;
}

export const TIER_LIMITS: Record<UserTier, ResourceLimits> = {
  free: {
    memoryMB: 256,
    cpuCores: 0.25,
    diskMB: 500,
    maxSessions: 3,
    maxContainerTimeSec: 30 * 60,
    dailyApiCalls: 50,
  },
  basic: {
    memoryMB: 512,
    cpuCores: 0.5,
    diskMB: 2048,
    maxSessions: 10,
    maxContainerTimeSec: 2 * 60 * 60,
    dailyApiCalls: 500,
  },
  pro: {
    memoryMB: 1024,
    cpuCores: 1.0,
    diskMB: 10240,
    maxSessions: 50,
    maxContainerTimeSec: 8 * 60 * 60,
    dailyApiCalls: 5000,
  },
};

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

export function getUserQuota(userId: string): UserQuota {
  const record = getQuotaRecord(userId);
  const today = todayStr();

  if (!record) {
    // New user — create default free quota
    const quota: UserQuota = {
      userId,
      tier: "free",
      limits: TIER_LIMITS.free,
      usage: {
        dailyApiCallsUsed: 0,
        totalContainerTimeSec: 0,
        diskUsageMB: 0,
        lastResetDate: today,
      },
    };
    upsertQuotaRecord(userId, quota.tier, quota.usage);
    return quota;
  }

  const tier = (record.tier as UserTier) || "free";
  let usage: ResourceUsage = {
    dailyApiCallsUsed: record.dailyApiCallsUsed,
    totalContainerTimeSec: record.totalContainerTimeSec,
    diskUsageMB: record.diskUsageMB,
    lastResetDate: record.lastResetDate,
  };

  // Reset daily counter if it's a new day
  if (usage.lastResetDate !== today) {
    usage.dailyApiCallsUsed = 0;
    usage.lastResetDate = today;
    upsertQuotaRecord(userId, tier, usage);
  }

  return {
    userId,
    tier,
    limits: TIER_LIMITS[tier],
    usage,
  };
}

export interface QuotaCheckResult {
  allowed: boolean;
  reason?: string;
}

export function checkQuota(
  userId: string,
  resource: "api_call" | "container" | "disk"
): QuotaCheckResult {
  const quota = getUserQuota(userId);

  switch (resource) {
    case "api_call":
      if (quota.usage.dailyApiCallsUsed >= quota.limits.dailyApiCalls) {
        return {
          allowed: false,
          reason: `Daily API call limit reached (${quota.limits.dailyApiCalls}). Upgrade for more.`,
        };
      }
      return { allowed: true };

    case "container":
      if (quota.usage.totalContainerTimeSec >= quota.limits.maxContainerTimeSec) {
        return {
          allowed: false,
          reason: `Container time limit reached (${Math.floor(quota.limits.maxContainerTimeSec / 60)} min).`,
        };
      }
      return { allowed: true };

    case "disk":
      if (quota.usage.diskUsageMB >= quota.limits.diskMB) {
        return {
          allowed: false,
          reason: `Disk quota exceeded (${quota.limits.diskMB}MB).`,
        };
      }
      return { allowed: true };

    default:
      return { allowed: true };
  }
}

export function incrementUsage(
  userId: string,
  resource: "api_call" | "container_time",
  amount: number = 1
): void {
  const quota = getUserQuota(userId);

  switch (resource) {
    case "api_call":
      quota.usage.dailyApiCallsUsed += amount;
      break;
    case "container_time":
      quota.usage.totalContainerTimeSec += amount;
      break;
  }

  upsertQuotaRecord(userId, quota.tier, quota.usage);
}
