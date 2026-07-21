import fs from "node:fs";
import { describe, expect, it } from "vitest";

describe("current public product claims", () => {
  const architecture = fs.readFileSync("docs/architecture.md", "utf8");
  const readme = fs.readFileSync("README.md", "utf8");
  const setup = fs.readFileSync("SETUP.md", "utf8");
  const pages = fs.readFileSync("apps/web/src/App.tsx", "utf8");

  it("pins the five-tool real product in the current architecture", () => {
    for (const tool of [
      "bander__list_capabilities",
      "bander__read_schedule",
      "bander__read_inbox",
      "bander__propose_action",
      "bander__get_receipt",
    ]) expect(architecture).toContain(tool);
    expect(architecture).toContain("exactly five Bander tools");
  });

  it("documents all three implemented product lanes and current limits", () => {
    expect(readme).toContain("bounded primary-Calendar reads");
    expect(readme).toContain("bounded Gmail inbox reads");
    expect(readme).toContain("one deterministic Telegram family update");
    expect(architecture).toContain("Standing autonomy remains sandbox-only");
    expect(setup).toContain("Core production authority is process-local and not restart-durable");
  });

  it("uses parent-readable Calendar change language in current public copy", () => {
    expect(readme).not.toContain("complete Calendar transition");
  });

  it("documents add and remove parity without broad Calendar-management claims", () => {
    expect(readme).toContain("all 27 outcomes");
    expect(readme).toContain("one exact plain-text Gmail reply");
    expect(architecture).toContain("Real creation is a separate action shape");
    expect(architecture).toContain("Real cancellation is a third explicit action shape");
    expect(readme).toContain("does not provide full Calendar management");
    expect(readme).not.toContain("all nine deterministic demo outcomes");
  });

  it("keeps the GPT-5.6 Sol frontier-fit claim coherent and truth-scoped", () => {
    expect(pages).toContain("WHY THIS IS POSSIBLE NOW");
    expect(pages).toContain("The missing piece was never intelligence. It was trust — and that is the part Bander adds.");
    expect(readme).toContain("Our live probe suites passed 49 natural and adversarial cases, with zero false accepts in those runs.");
    expect(readme).toContain("That solved the understanding. It did not solve the trust");
    expect(architecture).toContain("GPT-5.6 Sol compiles intent but cannot author authority");

    const whyNowIndex = pages.indexOf("WHY THIS IS POSSIBLE NOW");
    const fairQuestionIndex = pages.indexOf("<ComparisonThread");
    expect(whyNowIndex).toBeGreaterThan(-1);
    expect(fairQuestionIndex).toBeGreaterThan(whyNowIndex);

    for (const publicSurface of [pages, readme, architecture]) {
      expect(publicSurface).not.toContain("GPT-5.6 Sol is safe");
      expect(publicSurface).not.toContain("GPT-5.6 Sol is injection-immune");
    }
  });

  it("retires the internal build plan and standalone banner from the public README", () => {
    expect(fs.existsSync("Bander_Build_Plan.md")).toBe(false);
    expect(readme).not.toContain("Bander_Build_Plan.md");
    expect(readme).not.toContain("docs/assets/bander-banner.svg");
    expect(readme).toContain("docs/assets/bander-mark.svg");
    expect(readme).toContain("# Bander");
    expect(readme).toContain("**The OpenClaw I’d actually give my parents.**");
  });

  it("links the final public video without presenting stale GIF loops", () => {
    const videoUrl = "https://www.youtube.com/watch?v=z7OrvquejvQ";
    expect(readme).toContain("## Demo");
    expect(readme).toContain(`<a href="${videoUrl}">`);
    expect(readme).toContain('<img src="https://img.youtube.com/vi/z7OrvquejvQ/hqdefault.jpg" alt="Watch the Bander product demo" width="640" />');
    expect(readme).toContain(`- Watch: ${videoUrl}`);
    expect(readme).toContain("- Try: https://gowtham0992.github.io/bander/");
    expect(readme).toContain("- Source: https://github.com/gowtham0992/bander");
    expect(readme).not.toContain("docs/assets/screenshots/bander-social-preview.png");
    expect(readme).not.toContain("docs/assets/media/telegram-real-product-loop.gif");
    expect(readme).not.toContain("docs/assets/media/sandbox-episode.gif");
    expect(readme).not.toMatch(/Gil(?:’s separate phone|’s phone)?\s+(?:receives|reads)\b/i);
  });

  it("pins the current verification count and supported failure-first claim", () => {
    expect(readme).toContain("535 functional cases plus 26 adversarial cases");
    expect(readme).toContain("Load bearing safety properties were observed failing before their fixes.");
    expect(readme).not.toMatch(/every load[- ]bearing (?:safety )?propert/i);
  });
});
