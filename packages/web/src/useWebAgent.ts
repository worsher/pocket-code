import { useSyncExternalStore } from "react";
import type { WebAgentStore, AgentState } from "./webAgentStore";

export function useWebAgent(store: WebAgentStore): AgentState {
  return useSyncExternalStore(
    (cb) => store.subscribe(cb),
    () => store.getState()
  );
}
