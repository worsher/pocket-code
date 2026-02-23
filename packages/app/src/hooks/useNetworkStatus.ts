// ── Network Status Hook ──────────────────────────────────
// Monitors network connectivity and provides online/offline state.

import { useState, useEffect, useRef, useCallback } from "react";
import NetInfo, { type NetInfoState } from "@react-native-community/netinfo";

export interface NetworkStatus {
  isOnline: boolean;
  isWifi: boolean;
  type: string;
}

/**
 * Hook that monitors network connectivity.
 * Returns current network status and a callback to register
 * for online/offline transitions.
 */
export function useNetworkStatus() {
  const [status, setStatus] = useState<NetworkStatus>({
    isOnline: true,
    isWifi: false,
    type: "unknown",
  });

  const onlineCallbacksRef = useRef<Array<() => void>>([]);

  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener((state: NetInfoState) => {
      const isOnline = !!(state.isConnected && state.isInternetReachable !== false);
      const isWifi = state.type === "wifi";
      const prevOnline = status.isOnline;

      setStatus({
        isOnline,
        isWifi,
        type: state.type,
      });

      // Fire callbacks when transitioning from offline to online
      if (!prevOnline && isOnline) {
        for (const cb of onlineCallbacksRef.current) {
          try { cb(); } catch {}
        }
      }
    });

    return () => unsubscribe();
  }, []);

  const onReconnect = useCallback((callback: () => void) => {
    onlineCallbacksRef.current.push(callback);
    return () => {
      onlineCallbacksRef.current = onlineCallbacksRef.current.filter(
        (cb) => cb !== callback
      );
    };
  }, []);

  return { ...status, onReconnect };
}
