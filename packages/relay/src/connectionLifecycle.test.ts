import { describe, expect, it } from "vitest";
import type { WebSocket } from "ws";
import { expireStaleRequests } from "./connectionLifecycle.js";
import { RequestTracker } from "./requestTracker.js";

class MockWs {
  readyState = 1;
  sent: unknown[] = [];

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
}

const asWs = (ws: MockWs) => ws as unknown as WebSocket;

describe("tracked request expiry", () => {
  it("sends a correlated timeout to an open App before removing the tracker", () => {
    const requests = new RequestTracker<WebSocket>(100);
    const app = new MockWs();
    requests.track("turn-timeout", asWs(app), "m_A", 1_000, "message");

    const expired = expireStaleRequests(requests, 1_101);

    expect(expired).toEqual([
      expect.objectContaining({
        requestId: "turn-timeout",
        reason: "timeout",
      }),
    ]);
    expect(app.sent).toEqual([
      {
        type: "relay-response",
        requestId: "turn-timeout",
        payload: {
          type: "error",
          error: "Relay request timed out waiting for daemon response.",
        },
      },
    ]);
    expect(requests.get("turn-timeout")).toBeUndefined();
  });

  it("prunes a closed App socket without trying to send and preserves fresh requests", () => {
    const requests = new RequestTracker<WebSocket>(100);
    const closed = new MockWs();
    closed.readyState = 3;
    const fresh = new MockWs();
    requests.track("closed", asWs(closed), "m_A", 1_000);
    requests.track("fresh", asWs(fresh), "m_A", 1_050);

    expireStaleRequests(requests, 1_100);

    expect(closed.sent).toEqual([]);
    expect(requests.get("closed")).toBeUndefined();
    expect(requests.get("fresh")).toBeDefined();
  });
});
