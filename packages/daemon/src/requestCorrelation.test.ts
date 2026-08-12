import { describe, expect, it } from "vitest";
import { RequestCorrelationContext } from "./requestCorrelation";

describe("RequestCorrelationContext", () => {
  it("keeps overlapping async responses bound to their own request ids", async () => {
    const context = new RequestCorrelationContext();
    const observed: string[] = [];
    const first = context.run("req-first", async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      observed.push(context.current("fallback"));
    });
    const second = context.run("req-second", async () => {
      await Promise.resolve();
      observed.push(context.current("fallback"));
    });
    await Promise.all([first, second]);
    expect(observed).toEqual(["req-second", "req-first"]);
    expect(context.current("fallback")).toBe("fallback");
  });
});
