import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod/v4";
import type { DraftFixture } from "@bander/core";

const fixtureIds = [
  "move-dinner-and-notify-sarah",
  "move-my-focus-block",
  "move-dinner-under-standing-band",
  "unsupported",
] as const;

const SelectionSchema = z.object({
  fixtureId: z.enum(fixtureIds),
  needsClarification: z.boolean(),
  clarification: z.string().max(240),
});

type Selection = z.infer<typeof SelectionSchema>;

export interface CandidateSelector {
  select(agentClaimedRequest: string): Promise<Selection>;
}

export interface DraftCompiler {
  compile(agentClaimedRequest: string): Promise<DraftFixture>;
}

export class CompilerError extends Error {
  constructor(
    readonly code: "unsupported_request" | "clarification_required" | "model_unavailable",
    message: string,
  ) {
    super(message);
  }
}

export class FixtureDraftCompiler implements DraftCompiler {
  readonly #fixtures: Map<string, DraftFixture>;
  readonly #selector: CandidateSelector;

  constructor(
    fixtures: Map<string, DraftFixture>,
    selector: CandidateSelector,
  ) {
    this.#fixtures = fixtures;
    this.#selector = selector;
  }

  async compile(agentClaimedRequest: string): Promise<DraftFixture> {
    const selection = await this.#selector.select(agentClaimedRequest);
    if (selection.needsClarification) {
      throw new CompilerError(
        "clarification_required",
        selection.clarification || "The request needs clarification before Bander can prepare a deal.",
      );
    }
    if (selection.fixtureId === "unsupported") {
      throw new CompilerError(
        "unsupported_request",
        "That request is outside this local Bander demo.",
      );
    }
    const fixture = this.#fixtures.get(selection.fixtureId);
    if (!fixture) {
      throw new CompilerError("unsupported_request", "Selected fixture is unavailable.");
    }
    return {
      ...structuredClone(fixture),
      claimedUserRequest: agentClaimedRequest,
    };
  }
}

export class OpenAISelector implements CandidateSelector {
  readonly #client: OpenAI;

  constructor(apiKey: string) {
    this.#client = new OpenAI({ apiKey, timeout: 10_000, maxRetries: 1 });
  }

  async select(agentClaimedRequest: string): Promise<Selection> {
    try {
      const response = await this.#client.responses.parse({
        model: "gpt-5.6",
        store: false,
        reasoning: { effort: "low" },
        max_output_tokens: 300,
        instructions: [
          "You are Bander's candidate Draft selector, not an authority system.",
          "Select only an exact matching versioned local fixture.",
          "Use move-dinner-and-notify-sarah only for moving dinner with Sarah to 7:30 and sending the exact late-arrival notice.",
          "Use move-my-focus-block only for moving the owner's solo focus block to 10:30.",
          "Use move-dinner-under-standing-band only for moving dinner with Sarah to 7:30 without a message.",
          "If any material detail differs or is ambiguous, return unsupported or request clarification.",
          "You cannot approve, execute, alter payloads, or enlarge authority.",
        ].join(" "),
        input: agentClaimedRequest,
        text: {
          format: zodTextFormat(SelectionSchema, "bander_fixture_selection"),
        },
      });
      if (!response.output_parsed) {
        throw new CompilerError(
          "model_unavailable",
          "GPT-5.6 did not return a usable candidate.",
        );
      }
      return response.output_parsed;
    } catch (error) {
      if (error instanceof CompilerError) throw error;
      throw new CompilerError(
        "model_unavailable",
        "GPT-5.6 is temporarily unavailable. The deterministic demo still works.",
      );
    }
  }
}

export function createOpenAIDraftCompiler(
  apiKey: string,
  fixtures: Map<string, DraftFixture>,
): DraftCompiler {
  return new FixtureDraftCompiler(fixtures, new OpenAISelector(apiKey));
}
