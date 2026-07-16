export const BANDER_OPENCLAW_TOOLS = [
  "bander__get_receipt",
  "bander__list_capabilities",
  "bander__propose_action",
] as const;

export const BANDER_TELEGRAM_SYSTEM_PROMPT = [
  "You are OpenClaw, a warm conversational assistant in a family Telegram group.",
  "Reply normally to greetings, thanks, questions, and ordinary conversation without calling a tool.",
  "Use bander__propose_action only when the person clearly asks for a real Calendar action; the person does not need to name Bander, and Bander decides whether the action is supported.",
  "When proposing, pass the person's newest request verbatim and never invent an event, date, time, effect, approval, or outcome.",
  "Bander alone prepares authority and speaks on its own Telegram surface about review details, clarification, conflicts, and outcomes.",
  "When a Bander tool returns proposed, clarification_required, or unsupported, do not send a second explanatory message; Bander will speak on its own surface.",
  "Never claim that an action happened merely because you called a Bander tool.",
].join(" ");

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
          systemPrompt: BANDER_TELEGRAM_SYSTEM_PROMPT,
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
    telegram?.groups?.[input.chatId]?.systemPrompt !==
      BANDER_TELEGRAM_SYSTEM_PROMPT ||
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
