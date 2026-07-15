export interface TelegramSpikeBinding {
  ownerId: string;
  nonOwnerId: string;
  chatId: string;
  messageId: number;
  callbackData: string;
}

export interface TelegramSpikeCallback {
  fromId: string;
  chatId: string;
  messageId: number;
  data: string;
  nonOwnerCheckComplete: boolean;
}

export type TelegramSpikeCallbackDecision =
  | "wrong_surface"
  | "non_owner_denied"
  | "unbound_user_denied"
  | "owner_wait"
  | "owner_allowed";

export function classifyTelegramSpikeCallback(
  binding: TelegramSpikeBinding,
  callback: TelegramSpikeCallback,
): TelegramSpikeCallbackDecision {
  if (
    callback.chatId !== binding.chatId ||
    callback.messageId !== binding.messageId ||
    callback.data !== binding.callbackData
  ) {
    return "wrong_surface";
  }
  if (callback.fromId === binding.nonOwnerId) return "non_owner_denied";
  if (callback.fromId !== binding.ownerId) return "unbound_user_denied";
  if (!callback.nonOwnerCheckComplete) return "owner_wait";
  return "owner_allowed";
}
