import { describe, expect, it } from "vitest";

describe("cloudflare mcp project", () => {
  it("documents the expected tool set", () => {
    const tools = ["web_search", "get_sources", "web_fetch", "web_map", "get_config_info"];
    expect(tools).toHaveLength(5);
    expect(tools).toContain("web_search");
  });
});
