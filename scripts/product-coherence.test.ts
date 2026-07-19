import fs from "node:fs";
import { describe, expect, it } from "vitest";

describe("current public product claims", () => {
  const plan = fs.readFileSync("Bander_Build_Plan.md", "utf8");
  const readme = fs.readFileSync("README.md", "utf8");
  const pages = fs.readFileSync("apps/web/src/App.tsx", "utf8");

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

  it("keeps the GPT-5.6 Sol frontier-fit claim coherent and truth-scoped", () => {
    expect(pages).toContain("WHY THIS IS POSSIBLE NOW");
    expect(pages).toContain("The missing piece was never intelligence. It was trust — and that is the part Bander adds.");
    expect(readme).toContain("Our live probe suites passed 49 natural and adversarial cases, with zero false accepts in those runs.");
    expect(readme).toContain("That solved the understanding. It did not solve the trust");
    expect(plan).toContain("The two claims are deliberately separate.");

    const whyNowIndex = pages.indexOf("WHY THIS IS POSSIBLE NOW");
    const fairQuestionIndex = pages.indexOf("<ComparisonThread");
    expect(whyNowIndex).toBeGreaterThan(-1);
    expect(fairQuestionIndex).toBeGreaterThan(whyNowIndex);

    for (const publicSurface of [pages, readme, plan]) {
      expect(publicSurface).not.toContain("GPT-5.6 Sol is safe");
      expect(publicSurface).not.toContain("GPT-5.6 Sol is injection-immune");
    }
  });

  it("uses one cache-safe, truth-scoped real-evidence animation", () => {
    expect(readme.match(/docs\/assets\/media\/telegram-real-[^)\s]+\.gif/g)).toEqual([
      "docs/assets/media/telegram-real-product-loop.gif",
    ]);
    expect(readme).toContain("the approved update visible on Gil’s separate phone");
    expect(readme).not.toMatch(/Gil(?:’s separate phone|’s phone)?\s+(?:receives|reads)\b/i);
  });
});
