import { describe, expect, it } from "vitest";
import { classifyTelegramSpikeCallback } from "./telegram-spike-boundary.js";

const binding = {
  ownerId: "1001",
  nonOwnerId: "1002",
  chatId: "-1002003",
  messageId: 44,
  callbackData: "bander:approve:opaque",
};

describe("Telegram privacy-spike callback boundary", () => {
  it("denies the bound non-owner without granting authority", () => {
    expect(
      classifyTelegramSpikeCallback(binding, {
        fromId: binding.nonOwnerId,
        chatId: binding.chatId,
        messageId: binding.messageId,
        data: binding.callbackData,
        nonOwnerCheckComplete: false,
      }),
    ).toBe("non_owner_denied");
  });

  it("allows the owner only on the exact Bander-authored surface", () => {
    expect(
      classifyTelegramSpikeCallback(binding, {
        fromId: binding.ownerId,
        chatId: binding.chatId,
        messageId: binding.messageId,
        data: binding.callbackData,
        nonOwnerCheckComplete: true,
      }),
    ).toBe("owner_allowed");

    expect(
      classifyTelegramSpikeCallback(binding, {
        fromId: binding.ownerId,
        chatId: binding.chatId,
        messageId: binding.messageId + 1,
        data: binding.callbackData,
        nonOwnerCheckComplete: true,
      }),
    ).toBe("wrong_surface");
  });

  it("rejects an OpenClaw imitation and unknown users", () => {
    expect(
      classifyTelegramSpikeCallback(binding, {
        fromId: binding.ownerId,
        chatId: binding.chatId,
        messageId: 99,
        data: "openclaw:imitation",
        nonOwnerCheckComplete: true,
      }),
    ).toBe("wrong_surface");

    expect(
      classifyTelegramSpikeCallback(binding, {
        fromId: "9999",
        chatId: binding.chatId,
        messageId: binding.messageId,
        data: binding.callbackData,
        nonOwnerCheckComplete: true,
      }),
    ).toBe("unbound_user_denied");
  });

  it("does not let the owner skip the non-owner boundary check", () => {
    expect(
      classifyTelegramSpikeCallback(binding, {
        fromId: binding.ownerId,
        chatId: binding.chatId,
        messageId: binding.messageId,
        data: binding.callbackData,
        nonOwnerCheckComplete: false,
      }),
    ).toBe("owner_wait");
  });
});
