import fs from "node:fs";
import { describe, expect, it } from "vitest";

describe("current public product claims", () => {
  const plan = fs.readFileSync("Bander_Build_Plan.md", "utf8");
  const readme = fs.readFileSync("README.md", "utf8");

  it("keeps the product source of truth on the five-tool real product", () => {
    for (const tool of [
      "bander__list_capabilities",
      "bander__read_schedule",
      "bander__read_inbox",
      "bander__propose_action",
      "bander__get_receipt",
    ]) expect(plan).toContain(tool);
    expect(plan).toContain("exactly five Bander tools");
    expect(plan).not.toContain("exactly three Bander tools");
  });

  it("documents all three implemented product lanes and current limits", () => {
    expect(plan).toContain("bounded schedule reads");
    expect(plan).toContain("bounded Gmail reads");
    expect(plan).toContain("compound Calendar change plus deterministic family update");
    expect(plan).toContain("Standing autonomy remains sandbox-only");
    expect(plan).toContain("process-local");
    expect(plan).not.toContain("general schedule reading or summarization");
    expect(plan).not.toContain("email or message sending in real mode");
  });

  it("uses parent-readable Calendar change language in current public copy", () => {
    expect(readme).not.toContain("complete Calendar transition");
  });

  it("documents add and remove parity without broad Calendar-management claims", () => {
    expect(readme).toContain("all 27 outcomes");
    expect(plan).toContain("seeded email read/reply");
    expect(readme).toContain("does not provide full Calendar management");
    expect(readme).not.toContain("all nine deterministic demo outcomes");
  });
});
