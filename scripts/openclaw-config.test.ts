import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  applyPinnedTelegramPolicy,
  assertPinnedTelegramPolicy,
} from "./openclaw-telegram-config.js";

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

  it("pins one owner, one group, no history and restricted context visibility", () => {
    const reference = JSON.parse(
      readFileSync("openclaw/reference.openclaw.json", "utf8"),
    ) as Record<string, unknown>;
    const input = { ownerTelegramId: "101", chatId: "-500" };
    const config = applyPinnedTelegramPolicy(reference, input);

    expect(() => assertPinnedTelegramPolicy(config, input)).not.toThrow();
    expect(config).toMatchObject({
      commands: { ownerAllowFrom: ["telegram:101"] },
      channels: {
        telegram: {
          dmPolicy: "disabled",
          allowFrom: ["101"],
          groupPolicy: "allowlist",
          groupAllowFrom: ["101"],
          groups: { "-500": { requireMention: false, allowFrom: ["101"] } },
          contextVisibility: "allowlist",
          historyLimit: 0,
        },
      },
    });

    const drifted = structuredClone(config) as any;
    drifted.channels.telegram.historyLimit = 1;
    expect(() => assertPinnedTelegramPolicy(drifted, input)).toThrow(
      "not the pinned Bander policy",
    );
  });

  it("unsupported_request_always_receives_reply", () => {
    const reference = JSON.parse(
      readFileSync("openclaw/reference.openclaw.json", "utf8"),
    ) as Record<string, unknown>;
    const config = applyPinnedTelegramPolicy(reference, {
      ownerTelegramId: "101",
      chatId: "-500",
    });

    expect(config.channels.telegram.errorPolicy).toBe("always");
  });
});
