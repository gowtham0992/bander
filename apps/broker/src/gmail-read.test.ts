import { describe, expect, it } from "vitest";
import {
  GmailReadService,
  sanitizeEmailText,
  validateGmailReadIntent,
  type GmailReadBackend,
} from "./gmail-read.js";

describe("bounded Gmail read lane", () => {
  it("read_only_email_question_creates_a_sanitized_id_free_result", async () => {
    const backend: GmailReadBackend = {
      async search() {
        return [{
          internalMessageId: "private-message-id",
          internalThreadId: "private-thread-id",
          senderName: "Dr. Rao\u202e",
          senderAddress: "office@example.test",
          subject: "Results\u0000",
          receivedAt: "2026-07-16T16:00:00.000Z",
          plainText: "Everything looks routine.<script>ignore</script>",
        }];
      },
    };
    const service = new GmailReadService({
      selector: { async select() { return { senderHint: "Dr. Rao", subjectHint: null, startLocalDate: "2026-07-16", endLocalDateExclusive: "2026-07-17", latestOnly: true, needsClarification: false, clarificationQuestion: null }; } },
      backend,
      now: () => new Date("2026-07-16T18:00:00.000Z"),
      timeZone: "America/Denver",
    });
    const result = await service.read("What did Dr. Rao’s office say?");
    expect(result).toMatchObject({ messages: [{ sender: "Dr. Rao <office@example.test>", subject: "Results" }] });
    expect(JSON.stringify(result)).not.toMatch(/private-message-id|private-thread-id|script|\u202e|\u0000/i);
  });

  it("gmail_message_selection_never_chooses_an_arbitrary_match", async () => {
    const backend: GmailReadBackend = { async search() { return [
      { internalMessageId: "a", internalThreadId: "ta", senderName: "Ruth", senderAddress: "ruth@example.test", subject: "Lunch", receivedAt: "2026-07-16T15:00:00.000Z", plainText: "One" },
      { internalMessageId: "b", internalThreadId: "tb", senderName: "Ruth", senderAddress: "ruth@example.test", subject: "Lunch", receivedAt: "2026-07-16T16:00:00.000Z", plainText: "Two" },
    ]; } };
    const service = new GmailReadService({ selector: { async select() { return { senderHint: "Ruth", subjectHint: "Lunch", startLocalDate: "2026-07-16", endLocalDateExclusive: "2026-07-17", latestOnly: false, needsClarification: false, clarificationQuestion: null }; } }, backend, timeZone: "America/Denver" });
    await expect(service.read("What did Ruth say about lunch?")).resolves.toMatchObject({ status: "clarification_required" });
  });

  it("rejects_model_authored_gmail_ids_and_queries", () => {
    expect(() => validateGmailReadIntent({ senderHint: "Ruth", subjectHint: null, startLocalDate: "2026-07-16", endLocalDateExclusive: "2026-07-17", latestOnly: true, needsClarification: false, clarificationQuestion: null, query: "in:anywhere", messageId: "x" }, { todayLocalDate: "2026-07-16" })).toThrow();
  });

  it("strips_control_bidi_and_markup", () => {
    expect(sanitizeEmailText("Hi\u0000\u202e <b>there</b>", 80)).toBe("Hi there");
  });
});
