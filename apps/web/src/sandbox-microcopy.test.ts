import fs from "node:fs";
import { describe, expect, it } from "vitest";

describe("final sandbox microcopy", () => {
  const source = fs.readFileSync("apps/web/src/App.tsx", "utf8");

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
});
