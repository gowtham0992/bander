export const BANDER_OPENCLAW_TOOLS = [
  "bander__get_receipt",
  "bander__list_capabilities",
  "bander__propose_action",
] as const;

interface TelegramPolicyInput {
  ownerTelegramId: string;
  chatId: string;
}

type JsonObject = Record<string, any>;

export function applyPinnedTelegramPolicy(
  referenceConfig: JsonObject,
  input: TelegramPolicyInput,
): JsonObject {
  const config = structuredClone(referenceConfig);
  config.commands = {
    native: false,
    ownerAllowFrom: [`telegram:${input.ownerTelegramId}`],
  };
  config.channels = {
    telegram: {
      enabled: true,
      dmPolicy: "disabled",
      allowFrom: [input.ownerTelegramId],
      groupPolicy: "allowlist",
      groupAllowFrom: [input.ownerTelegramId],
      groups: {
        [input.chatId]: {
          requireMention: false,
          allowFrom: [input.ownerTelegramId],
        },
      },
      contextVisibility: "allowlist",
      historyLimit: 0,
      configWrites: false,
      streaming: { mode: "off" },
      errorPolicy: "always",
      capabilities: { inlineButtons: "group" },
    },
  };
  return config;
}

export function assertPinnedTelegramPolicy(
  config: JsonObject,
  input: TelegramPolicyInput,
): void {
  const telegram = config.channels?.telegram;
  const tools = [...(config.tools?.allow ?? [])].sort();
  const mcpTools = [...(config.mcp?.servers?.bander?.toolFilter?.include ?? [])]
    .map((name) => `bander__${name}`)
    .sort();
  if (
    JSON.stringify(tools) !== JSON.stringify([...BANDER_OPENCLAW_TOOLS]) ||
    JSON.stringify(mcpTools) !== JSON.stringify([...BANDER_OPENCLAW_TOOLS]) ||
    JSON.stringify(config.commands?.ownerAllowFrom) !==
      JSON.stringify([`telegram:${input.ownerTelegramId}`]) ||
    telegram?.dmPolicy !== "disabled" ||
    telegram?.groupPolicy !== "allowlist" ||
    JSON.stringify(telegram?.allowFrom) !==
      JSON.stringify([input.ownerTelegramId]) ||
    JSON.stringify(telegram?.groupAllowFrom) !==
      JSON.stringify([input.ownerTelegramId]) ||
    Object.keys(telegram?.groups ?? {}).length !== 1 ||
    telegram?.groups?.[input.chatId]?.requireMention !== false ||
    JSON.stringify(telegram?.groups?.[input.chatId]?.allowFrom) !==
      JSON.stringify([input.ownerTelegramId]) ||
    telegram?.contextVisibility !== "allowlist" ||
    telegram?.historyLimit !== 0 ||
    telegram?.errorPolicy !== "always" ||
    telegram?.configWrites !== false
  ) {
    throw new Error("OpenClaw Telegram policy is not the pinned Bander policy");
  }
}
