import { createHash } from "node:crypto";
import type {
  DraftDocument,
  FamilyNotificationDocument,
  FamilyTelegramNotificationEffect,
  ObservedExecutionResult,
} from "@bander/contracts";
import type { ExecutionAdapter } from "@bander/core";

export type BoundFamilyNotificationDelivery = {
  requestId: string;
  binding: FamilyTelegramNotificationEffect["binding"];
  document: FamilyNotificationDocument;
};

type DeliveryResult = {
  status: "delivered" | "ambiguous" | "not_sent";
};

export function compoundDeliveryRequestId(
  draftHash: string,
  permitNonce: string,
): string {
  return `compound_${createHash("sha256")
    .update(`${draftHash}:${permitNonce}`, "utf8")
    .digest("hex")}`;
}

function compoundEffects(document: DraftDocument) {
  const calendar = document.effects.find(
    (effect) =>
      effect.type === "calendar.reschedule_event" ||
      effect.type === "calendar.create_event" ||
      effect.type === "calendar.cancel_event",
  );
  const family = document.effects.find(
    (effect): effect is FamilyTelegramNotificationEffect =>
      effect.type === "family.telegram_notification",
  );
  return { calendar, family };
}

export class CompoundExecutionAdapter implements ExecutionAdapter {
  readonly #results = new Map<string, { draftHash: string; result: ObservedExecutionResult }>();

  constructor(
    readonly options: {
      calendar: ExecutionAdapter;
      deliver: (input: BoundFamilyNotificationDelivery) => Promise<DeliveryResult>;
    },
  ) {}

  resolveEvent(id: string) {
    return this.options.calendar.resolveEvent(id);
  }

  resolvePerson(id: string) {
    return this.options.calendar.resolvePerson(id);
  }

  async executeDraft(input: {
    draftHash: string;
    permitNonce: string;
    document: DraftDocument;
  }): Promise<ObservedExecutionResult> {
    const existing = this.#results.get(input.permitNonce);
    if (existing) {
      if (existing.draftHash !== input.draftHash) {
        throw new Error("compound_execution_identity_mismatch");
      }
      return structuredClone(existing.result);
    }
    const { calendar, family } = compoundEffects(input.document);
    if (
      !calendar ||
      input.document.effects.some(
        (effect) =>
          effect.type !== "calendar.reschedule_event" &&
          effect.type !== "calendar.create_event" &&
          effect.type !== "calendar.cancel_event" &&
          effect.type !== "family.telegram_notification",
      ) ||
      input.document.effects.length !== (family ? 2 : 1)
    ) {
      throw new Error("unsupported_real_execution_shape");
    }
    const calendarDocument: DraftDocument = {
      ...input.document,
      effects: [calendar],
    };
    const observed = await this.options.calendar.executeDraft({
      ...input,
      document: calendarDocument,
    });
    if (!observed || !("calendar" in observed)) {
      throw new Error("real_calendar_observation_missing");
    }
    const result: ObservedExecutionResult = {
      calendar: structuredClone(observed.calendar),
    };
    if (family) {
      const delivery = await this.options.deliver({
        requestId: compoundDeliveryRequestId(input.draftHash, input.permitNonce),
        binding: structuredClone(family.binding),
        document: structuredClone(family.document),
      });
      result.familyNotification = { status: delivery.status };
    }
    this.#results.set(input.permitNonce, {
      draftHash: input.draftHash,
      result: structuredClone(result),
    });
    return result;
  }

  async getExecution(input: {
    draftHash: string;
    permitNonce: string;
    document: DraftDocument;
  }): Promise<boolean | ObservedExecutionResult> {
    const cached = this.#results.get(input.permitNonce);
    if (cached) {
      return cached.draftHash === input.draftHash
        ? structuredClone(cached.result)
        : false;
    }
    const { calendar, family } = compoundEffects(input.document);
    if (!calendar) return false;
    const calendarResult = await this.options.calendar.getExecution({
      ...input,
      document: { ...input.document, effects: [calendar] },
    });
    if (!calendarResult || typeof calendarResult === "boolean") {
      return family ? false : calendarResult;
    }
    const result: ObservedExecutionResult = {
      calendar: structuredClone(calendarResult.calendar),
    };
    if (family) {
      const delivery = await this.options.deliver({
        requestId: compoundDeliveryRequestId(input.draftHash, input.permitNonce),
        binding: structuredClone(family.binding),
        document: structuredClone(family.document),
      });
      result.familyNotification = { status: delivery.status };
    }
    this.#results.set(input.permitNonce, {
      draftHash: input.draftHash,
      result: structuredClone(result),
    });
    return result;
  }
}
