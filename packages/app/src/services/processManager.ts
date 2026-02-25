/**
 * processManager.ts
 *
 * JS-side process registry for long-running background processes.
 * Bridges native onProcessOutput / onProcessExit events to React state.
 */
import { requireNativeModule } from "expo-modules-core";

// ── Types ──────────────────────────────────────────────────────────────────

export interface ProcessInfo {
    id: number;
    command: string;
    status: "running" | "exited" | "killed";
    exitCode?: number;
    outputLines: string[];
    startedAt: number;
}

type ProcessListener = (processes: ReadonlyMap<number, ProcessInfo>) => void;

// ── Internal state ─────────────────────────────────────────────────────────

const processes = new Map<number, ProcessInfo>();
const listeners = new Set<ProcessListener>();

let nativeSubscribed = false;

function notify() {
    const snap: ReadonlyMap<number, ProcessInfo> = new Map(processes);
    listeners.forEach((fn) => fn(snap));
}

function ensureNativeSubscribed() {
    if (nativeSubscribed) return;
    nativeSubscribed = true;

    const mod = requireNativeModule("PocketTerminalModule");

    mod.addListener("onProcessOutput", (event: { processId: number; data: string }) => {
        const p = processes.get(event.processId);
        if (!p) return;
        p.outputLines.push(event.data);
        // Cap memory at 500 lines
        if (p.outputLines.length > 500) p.outputLines.splice(0, p.outputLines.length - 500);
        notify();
    });

    mod.addListener("onProcessExit", (event: { processId: number; exitCode: number }) => {
        const p = processes.get(event.processId);
        if (!p) return;
        p.status = "exited";
        p.exitCode = event.exitCode;
        notify();
    });
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Subscribe to process map updates.
 * Immediately calls fn with the current snapshot.
 * Returns an unsubscribe function.
 */
export function subscribeProcesses(fn: ProcessListener): () => void {
    ensureNativeSubscribed();
    listeners.add(fn);
    fn(new Map(processes));
    return () => { listeners.delete(fn); };
}

/** Get a single process by id (snapshot). */
export function getProcess(id: number): ProcessInfo | undefined {
    return processes.get(id);
}

/**
 * Start a background process via the native module.
 * command: the shell command string (already proot-wrapped if needed)
 * workdir: working directory passed to ProcessBuilder
 * label:   human-readable command label shown in UI
 */
export async function startNativeProcess(
    command: string,
    workdir: string,
    label: string
): Promise<{ success: boolean; processId?: number; error?: string }> {
    ensureNativeSubscribed();
    try {
        const mod = requireNativeModule("PocketTerminalModule");
        const result = await (mod.startProcess(command, workdir) as Promise<{ success: boolean; processId: number }>);
        if (result.success) {
            processes.set(result.processId, {
                id: result.processId,
                command: label,
                status: "running",
                outputLines: [],
                startedAt: Date.now(),
            });
            notify();
        }
        return result;
    } catch (e: any) {
        return { success: false, error: e.message ?? String(e) };
    }
}

/**
 * Kill a running background process.
 */
export function killProcess(processId: number): void {
    const mod = requireNativeModule("PocketTerminalModule");
    mod.stopProcess(processId);
    const p = processes.get(processId);
    if (p) {
        p.status = "killed";
        notify();
    }
}
