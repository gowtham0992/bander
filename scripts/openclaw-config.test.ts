import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface ReferenceConfig {
  tools: { allow: string[] };
  mcp: {
    servers: {
      bander: { toolFilter: { include: string[] } };
    };
  };
}

describe("OpenClaw reference tool manifest", () => {
  it("allowlists only Bander's three narrow MCP tools", () => {
    const config = JSON.parse(
      readFileSync("openclaw/reference.openclaw.json", "utf8"),
    ) as ReferenceConfig;

    expect(config.tools.allow).toEqual([
      "bander__list_capabilities",
      "bander__propose_action",
      "bander__get_receipt",
    ]);
    expect(config.mcp.servers.bander.toolFilter.include).toEqual([
      "list_capabilities",
      "propose_action",
      "get_receipt",
    ]);
    expect(config.tools.allow).not.toEqual(
      expect.arrayContaining(["exec", "browser", "message", "web_fetch", "web_search"]),
    );
  });
});
