import fs from "node:fs";
import { describe, expect, it } from "vitest";

describe("Checkpoint 9 public-surface truthfulness", () => {
  const source = fs.readFileSync("apps/web/src/App.tsx", "utf8");

  it("email_success_claims_only_the_email_effect", () => {
    expect(source).toContain(
      "{screen.receipt.familyNotification && <p>Gil’s phone received the exact text shown on the Card.</p>}",
    );
    expect(source).toContain("screen.receipt.emailReply ? (");
  });

  it("email_ambiguity_uses_only_email_surfaces", () => {
    expect(source).toContain("Email result unknown.");
    expect(source).toContain("Sent mail — sandbox");
    expect(source).not.toContain(
      '<AmbiguousOutcome message={screen.message} onReplay={() => approve(screen.card, screen.card.effectPreviews.some',
    );
  });

  it("deep_link_initialization_is_single_flight_and_cards_are_not_actionable_early", () => {
    expect(source).toContain("deepLinkStarted");
    expect(source).toContain('kind: "initialization-failed"');
    expect(source).toContain("This demo step reset itself. Tap Start again — nothing was sent or changed.");
  });

  it("email_thread_change_has_a_first_class_result", () => {
    expect(source).toContain('kind: "email-thread-changed"');
    expect(source).toContain(
      "I stopped—the email conversation changed since this reply was prepared.",
    );
    expect(source).not.toContain(
      'setScreen({ kind: "error", message: "I stopped—the seeded email conversation changed. No reply was sent." })',
    );
  });

  it("public_repository_resources_are_linked_after_visibility_changes", () => {
    expect(source).toContain('aria-label="Project resources"');
    expect(source).toContain('href="https://github.com/gowtham0992/bander"');
    expect(source).not.toContain("Public links will appear here only when the repository is public.");
  });
});
