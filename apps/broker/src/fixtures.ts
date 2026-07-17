import { readFileSync } from "node:fs";
import type { DraftFixture } from "@bander/core";
import { buildPinnedReply } from "./gmail.js";

interface DraftFixturesFile {
  version: 1;
  fixtures: DraftFixture[];
}

export function loadDraftFixtures(): Map<string, DraftFixture> {
  const fixtureUrl = new URL("../../../fixtures/v1/drafts.json", import.meta.url);
  const parsed = JSON.parse(readFileSync(fixtureUrl, "utf8")) as DraftFixturesFile;
  const fixtures = new Map(parsed.fixtures.map((fixture) => [fixture.id, fixture]));
  fixtures.set("reply-to-ruth-about-lunch", {
    id: "reply-to-ruth-about-lunch",
    claimedUserRequest: "Reply to Ruth’s lunch email: Tuesday at noon works for me.",
    emailReply: buildPinnedReply({
      source: {
        messageId: "sandbox-message-ruth-lunch",
        threadId: "sandbox-thread-ruth-lunch",
        latestThreadMessageId: "sandbox-message-ruth-lunch",
        rfcMessageId: "<sandbox-ruth-lunch@example.test>",
        references: [],
        replyRecipient: "ruth@example.test",
        subject: "Lunch next week",
      },
      body: "Tuesday at noon works for me.",
      stableMessageId: "<bander-sandbox-reply@example.invalid>",
    }),
  });
  fixtures.set("tell-gil-dinner-is-at-six", {
    id: "tell-gil-dinner-is-at-six",
    claimedUserRequest: "Tell Gil dinner is at 6.",
    familyNotification: {
      installationId: "sandbox-installation",
      contactId: "sandbox-contact-gil",
      pairingRevision: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      displayLabel: "Gil",
      document: { kind: "direct_message", body: "Dinner is at 6." },
    },
  });
  return fixtures;
}
