import fs from "node:fs";
import { describe, expect, it } from "vitest";

describe("final sandbox microcopy", () => {
  const source = fs.readFileSync("apps/web/src/App.tsx", "utf8");
  const styles = fs.readFileSync("apps/web/src/styles.css", "utf8");

  it("uses parent-readable quarantine labels", () => {
    expect(source).toContain('source="Calendar"');
    expect(source).toContain('source="Family member"');
    expect(source).toContain('source="Exact update from Bander"');
    expect(source).not.toContain('source="Calendar event title"');
    expect(source).not.toContain('source="Family contact"');
    expect(source).not.toContain('source="Bander-rendered update"');
  });

  it("explains the complete configured proposal window", () => {
    expect(source).toContain("requests in {card.proposalActivity.windowMinutes} minutes");
    expect(source).not.toContain("Request {card.proposalActivity.count} of");
  });

  it("renders no internal authority nouns on current parent-facing screens", () => {
    expect(source).not.toMatch(/>[^<{]*\b(?:Draft|Band|Permit|Receipt|ETag|hash|idempotency|scope|operation)\b[^<{]*</i);
    expect(source).not.toContain("Your agent can prepare a new Draft for you.");
  });

  it("frames only the uncertain sandbox journey outside the trusted Card", () => {
    expect(source).toContain(
      "The Calendar provider’s response will be deliberately lost after approval, so Bander must report only what it can prove.",
    );
    expect(source).toContain('screen.scenario === "ambiguous"');
    expect(source).toContain('<DealCard\n            card={screen.card}');
  });

  it("keeps concise explicit lane-button names and keyboard focus", () => {
    expect(source).toContain('<button className="lane-card read-lane" aria-label="Just ask"');
    expect(source).toContain("What’s on tomorrow? What did Ruth say?");
    expect(source).toContain('<button className="lane-card compound-lane" aria-label="Approve a change"');
    expect(source).toContain("Answer the email, update the calendar, tell Gil.");
    expect(source).toContain('<button className="lane-card uncertain-lane" aria-label="When Bander isn’t sure"');
    expect(source).toContain("See a truthful uncertain outcome.");
    expect(styles).toContain("button:focus-visible");
    expect(styles).toContain(".lane-card { width: 100%;");
  });

  it("keeps a compound deal in the compound lane after Change it", () => {
    expect(source).toContain('{ kind: "change"; card: ApprovalCard; scenario: DealScenario }');
    expect(source).toContain('setScreen({ kind: "change", card: screen.card, scenario: screen.scenario })');
    expect(source).toContain('scenario: screen.scenario');
  });

  it("keeps create and cancellation as secondary product journeys", () => {
    expect(source).toContain("Add or remove something from the Calendar");
    expect(source).toContain('"add-lunch-with-ruth-and-notify-gil"');
    expect(source).toContain('"cancel-dentist-and-notify-gil"');
    expect(source).toContain('cancels ? "Remove this event" : "Do exactly this"');
  });
});
