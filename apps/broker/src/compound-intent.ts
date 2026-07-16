import { z } from "zod";
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";

export const COMPOUND_SOL_MODEL = "gpt-5.6-sol" as const;

export const CompoundClarificationReasonSchema = z.enum([
  "missing_event_title",
  "missing_target_date",
  "missing_target_time",
  "ambiguous_relative_date",
  "missing_contact",
  "ambiguous_contact",
  "unpaired_contact",
  "free_form_message_unsupported",
  "multiple_events_unsupported",
  "unsupported_action",
]);

export const CompoundIntentOutputSchema = z
  .object({
    classification: z.enum(["ready", "clarification", "unsupported"]),
    eventTitleHint: z.string().trim().min(1).max(160).nullable(),
    sourceLocalDateHint: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
    targetLocalDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
    targetLocalStart: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable(),
    familyNotificationRequested: z.boolean(),
    familyContactAlias: z.string().trim().min(1).max(80).nullable(),
    clarificationReason: CompoundClarificationReasonSchema.nullable(),
    clarificationQuestion: z.string().trim().min(1).max(180).nullable(),
  })
  .strict();

export type CompoundIntentOutput = z.infer<typeof CompoundIntentOutputSchema>;

type ContactAlias = { key: string; aliases: readonly string[] };
type ValidationContext = {
  nowLocalDate: string;
  timeZone: string;
  contacts: readonly ContactAlias[];
};

export interface CompoundIntentSelector {
  select(request: string): Promise<unknown>;
}

export class CompoundIntentError extends Error {
  constructor(
    readonly code: "invalid_model_output" | "model_unavailable",
    message: string,
  ) {
    super(message);
    this.name = "CompoundIntentError";
  }
}

export class OpenAISolCompoundIntentSelector implements CompoundIntentSelector {
  readonly #client: OpenAI;
  readonly #timeZone: string;
  readonly #todayLocalDate: string;

  constructor(input: {
    apiKey: string;
    timeZone: string;
    todayLocalDate: string;
  }) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.todayLocalDate)) {
      throw new Error("invalid_compound_probe_date");
    }
    new Intl.DateTimeFormat("en-US", { timeZone: input.timeZone }).format();
    this.#client = new OpenAI({ apiKey: input.apiKey, timeout: 20_000, maxRetries: 1 });
    this.#timeZone = input.timeZone;
    this.#todayLocalDate = input.todayLocalDate;
  }

  async select(request: string): Promise<unknown> {
    try {
      const response = await this.#client.responses.parse({
        model: COMPOUND_SOL_MODEL,
        store: false,
        reasoning: { effort: "low" },
        max_output_tokens: 350,
        instructions: [
          "Extract only one narrow compound request: move one Calendar appointment and notify one already-paired family contact.",
          "You are advisory extraction. Bander independently resolves the Calendar event, contact alias, authority, and execution.",
          "Return only the strict schema. Never emit a Calendar ID, event ID, ETag, duration, end time, recipient address, Telegram ID, chat ID, username, callback destination, message body, effect list, execution ordering, permit, approval, authority, receipt, or idempotency value.",
          "eventTitleHint is a human title hint, never an identifier. sourceLocalDateHint is only the event's current date if the person explicitly supplied it.",
          "A descriptive noun phrase such as 'my appointment' is a valid event-title hint ('appointment'); only a bare pronoun such as 'it' or 'that' is missing.",
          "targetLocalDate and targetLocalStart are the requested destination in local YYYY-MM-DD and HH:mm form.",
          `Today is ${this.#todayLocalDate} in the connected Calendar timezone ${this.#timeZone}. Resolve only unambiguous relative dates in that timezone.`,
          "Within this parent-product appointment class, a bare requested clock hour from 1 through 6 means PM; do not apply that convention to any other hour.",
          "familyContactAlias is only the relationship or name the person used, never an address. A supplied name such as Gil or relationship such as my son is a complete alias hint; extract it exactly and let deterministic Bander code decide whether it is paired.",
          "Do not infer a contact behind an unresolved pronoun such as him, her, or them; classify that as ambiguous_contact.",
          "For a complete supported request set classification ready and clarification fields null.",
          "Use clarification when the event title, destination date, destination time, or paired-contact reference is missing or ambiguous; when multiple people are named; or when the request asks for arbitrary free-form notification content.",
          "Use unsupported for cancellation, deletion, purchases, payments, reservations, door locks, multiple Calendar events, or any action outside the narrow move-and-notify class.",
          "For clarification or unsupported, provide exactly one short plain-text question or explanation. Do not include private details.",
          "The future notification is rendered deterministically from the authoritative approved Calendar transition. Never author it.",
        ].join(" "),
        input: request,
        text: {
          format: zodTextFormat(CompoundIntentOutputSchema, "bander_compound_intent"),
        },
      });
      if (!response.output_parsed) {
        throw new CompoundIntentError(
          "invalid_model_output",
          "The model did not return a usable compound intent.",
        );
      }
      return CompoundIntentOutputSchema.parse(response.output_parsed);
    } catch (error) {
      if (error instanceof CompoundIntentError) throw error;
      if (error instanceof z.ZodError) {
        throw new CompoundIntentError(
          "invalid_model_output",
          "The model returned an invalid compound intent.",
        );
      }
      throw new CompoundIntentError(
        "model_unavailable",
        "GPT-5.6 Sol is temporarily unavailable.",
      );
    }
  }
}

export async function probeCompoundIntent(
  selector: CompoundIntentSelector,
  request: string,
  context: ValidationContext,
) {
  try {
    return validateCompoundIntent(await selector.select(request), context);
  } catch (error) {
    if (error instanceof CompoundIntentError) {
      return { status: error.code } as const;
    }
    if (error instanceof z.ZodError) {
      return { status: "invalid_model_output" } as const;
    }
    return { status: "model_unavailable" } as const;
  }
}

type ClarificationReason = z.infer<typeof CompoundClarificationReasonSchema>;

function clarification(reason: ClarificationReason, question: string) {
  return { status: "clarification_required", reason, question } as const;
}

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase("en-US");
}

export function validateCompoundIntent(
  raw: unknown,
  context: ValidationContext,
):
  | {
      status: "ready";
      eventTitleHint: string;
      sourceLocalDateHint: string | null;
      targetLocalDate: string;
      targetLocalStart: string;
      familyNotificationRequested: true;
      contactKey: string;
    }
  | {
      status: "clarification_required" | "unsupported";
      reason: ClarificationReason;
      question: string;
    } {
  const output = CompoundIntentOutputSchema.parse(raw);
  const outputAlias = output.familyContactAlias
    ? normalized(output.familyContactAlias)
    : null;
  const locallyMatchedContacts = outputAlias
    ? context.contacts.filter((contact) =>
        contact.aliases.some((candidate) => normalized(candidate) === outputAlias),
      )
    : [];
  if (
    output.classification === "clarification" &&
    outputAlias !== null &&
    ["him", "her", "them", "someone", "family"].includes(outputAlias)
  ) {
    return clarification(
      "ambiguous_contact",
      "Which paired family contact should I notify?",
    );
  }
  if (output.classification === "unsupported") {
    return {
      status: "unsupported",
      reason: output.clarificationReason ?? "unsupported_action",
      question:
        output.clarificationQuestion ??
        "I can only help move one appointment and notify a paired contact.",
    };
  }
  if (output.clarificationReason === "multiple_events_unsupported") {
    return {
      status: "unsupported",
      reason: "multiple_events_unsupported",
      question:
        output.clarificationQuestion ??
        "I can only prepare one Calendar event at a time.",
    };
  }
  if (output.classification === "clarification") {
    const locallyResolvedPairingMistake =
      output.clarificationReason === "unpaired_contact" &&
      locallyMatchedContacts.length === 1 &&
      output.eventTitleHint !== null &&
      output.targetLocalDate !== null &&
      output.targetLocalStart !== null &&
      output.familyNotificationRequested;
    if (!locallyResolvedPairingMistake) {
      return clarification(
        output.clarificationReason ?? "unsupported_action",
        output.clarificationQuestion ?? "What should I clarify?",
      );
    }
  }
  if (!output.eventTitleHint) {
    return clarification("missing_event_title", "Which appointment should I move?");
  }
  if (!output.targetLocalDate) {
    return clarification("missing_target_date", "What date should I move it to?");
  }
  if (!output.targetLocalStart) {
    return clarification("missing_target_time", "What time should I move it to?");
  }
  if (!output.familyNotificationRequested || !output.familyContactAlias) {
    return clarification("missing_contact", "Which paired family contact should I notify?");
  }

  const alias = normalized(output.familyContactAlias);
  if (["him", "her", "them", "someone", "family"].includes(alias)) {
    return clarification(
      "ambiguous_contact",
      "Which paired family contact should I notify?",
    );
  }
  const matches = locallyMatchedContacts;
  if (matches.length === 0) {
    return clarification(
      "unpaired_contact",
      `I don't have a paired family contact called ${output.familyContactAlias}. Who should I notify?`,
    );
  }
  if (matches.length > 1) {
    return clarification(
      "ambiguous_contact",
      `I found more than one paired contact called ${output.familyContactAlias}. Which one do you mean?`,
    );
  }
  return {
    status: "ready",
    eventTitleHint: output.eventTitleHint,
    sourceLocalDateHint: output.sourceLocalDateHint,
    targetLocalDate: output.targetLocalDate,
    targetLocalStart: output.targetLocalStart,
    familyNotificationRequested: true,
    contactKey: matches[0]!.key,
  };
}
