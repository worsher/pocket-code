import { describe, expect, it } from "vitest";
import {
  classifyCopySourceReconciliation,
  refreshSourceIdentityContent,
} from "./sourceReconciliation.js";

describe("copy source reconciliation", () => {
  it.each([
    ["base", "base", "base", "unchanged"],
    ["base", "same", "same", "converged"],
    ["base", "base", "source", "source-ahead"],
    ["base", "workspace", "base", "workspace-ahead"],
    ["base", "workspace", "source", "conflict"],
  ])("classifies base=%s workspace=%s source=%s", (base, workspace, source, expected) => {
    expect(
      classifyCopySourceReconciliation({
        importedSnapshot: base,
        workspaceSnapshot: workspace,
        sourceSnapshot: source,
      })
    ).toBe(expected);
  });

  it("refreshes only the advisory content key", () => {
    expect(
      refreshSourceIdentityContent(
        {
          importMode: "copy",
          sourceKind: "directory",
          strongKey: '["physical","phone","directory","platform-handle","42"]',
          weakKeys: ['["locator","phone","directory","content://old"]', '["content","old"]'],
        },
        "ABCDEF"
      )
    ).toEqual({
      importMode: "copy",
      sourceKind: "directory",
      strongKey: '["physical","phone","directory","platform-handle","42"]',
      weakKeys: ['["content","abcdef"]', '["locator","phone","directory","content://old"]'],
    });
  });
});
