import AsyncStorage from "@react-native-async-storage/async-storage";

export type WorkspaceMetricName =
  | "directory-conflict"
  | "stale-event"
  | "sync-failed"
  | "permission-lost"
  | "recovery-attempted"
  | "recovery-succeeded";

export interface WorkspaceMetricsSnapshot {
  version: 1;
  counters: Record<WorkspaceMetricName, number>;
  lastEventAt: Partial<Record<WorkspaceMetricName, number>>;
  recoverySuccessRate: number | null;
}

const STORAGE_KEY = "pocket-code:workspace-v2:metrics";
const EMPTY_COUNTERS: Record<WorkspaceMetricName, number> = {
  "directory-conflict": 0,
  "stale-event": 0,
  "sync-failed": 0,
  "permission-lost": 0,
  "recovery-attempted": 0,
  "recovery-succeeded": 0,
};
let writeTail: Promise<void> = Promise.resolve();

export async function getWorkspaceMetrics(): Promise<WorkspaceMetricsSnapshot> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) throw new Error("empty");
    const parsed = JSON.parse(raw) as Partial<WorkspaceMetricsSnapshot>;
    const counters = Object.fromEntries(
      Object.entries(EMPTY_COUNTERS).map(([name, fallback]) => [
        name,
        Number.isFinite(parsed.counters?.[name as WorkspaceMetricName])
          ? Number(parsed.counters?.[name as WorkspaceMetricName])
          : fallback,
      ])
    ) as Record<WorkspaceMetricName, number>;
    return {
      version: 1,
      counters,
      lastEventAt:
        parsed.lastEventAt && typeof parsed.lastEventAt === "object" ? parsed.lastEventAt : {},
      recoverySuccessRate:
        counters["recovery-attempted"] > 0
          ? counters["recovery-succeeded"] / counters["recovery-attempted"]
          : null,
    };
  } catch {
    return {
      version: 1,
      counters: { ...EMPTY_COUNTERS },
      lastEventAt: {},
      recoverySuccessRate: null,
    };
  }
}

export async function recordWorkspaceMetric(name: WorkspaceMetricName): Promise<void> {
  const write = writeTail
    .catch(() => undefined)
    .then(async () => {
      const current = await getWorkspaceMetrics();
      const now = Date.now();
      const next: WorkspaceMetricsSnapshot = {
        version: 1,
        counters: { ...current.counters, [name]: current.counters[name] + 1 },
        lastEventAt: { ...current.lastEventAt, [name]: now },
        recoverySuccessRate: current.recoverySuccessRate,
      };
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    });
  writeTail = write.catch(() => undefined);
  await write;
}
