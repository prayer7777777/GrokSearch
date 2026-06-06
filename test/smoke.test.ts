import { describe, expect, it } from "vitest";
import { cleanUrlCandidate, sourcesFromText } from "../src/source-utils";

describe("cloudflare mcp project", () => {
  it("documents the expected tool set", () => {
    const tools = ["web_search", "get_sources", "list_models", "switch_model", "web_fetch", "web_map", "get_config_info"];
    expect(tools).toHaveLength(7);
    expect(tools).toContain("web_search");
  });

  it("cleans citation tails from extracted source URLs", () => {
    expect(cleanUrlCandidate("https://help.example.com/release-notes**[[1")).toBe("https://help.example.com/release-notes");
    const sources = sourcesFromText(
      "See [release notes](https://help.example.com/release-notes)**[[1]] and https://help.example.com/release-notes**[[1",
      "grok",
      10,
      () => "2026-06-06T00:00:00.000Z",
    );

    expect(sources).toHaveLength(1);
    expect(sources[0].url).toBe("https://help.example.com/release-notes");
  });
});
