import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { initialFamilyThreadState, reduceFamilyThread } from "./family-thread-state.js";

const app = fs.readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const surfaces = fs.readFileSync(new URL("./family-thread-surface-view.tsx", import.meta.url), "utf8");
const styles = fs.readFileSync(new URL("./styles.css", import.meta.url), "utf8");
const publicSurface = `${app}\n${surfaces}`;
const ogSourcePath = new URL("../../../docs/assets/screenshots/bander-social-preview.svg", import.meta.url);

function reachHeldState() {
  const events = [
    "ask", "read_completed", "prepare_email", "email_card_ready", "email_approved",
    "prepare_compound", "compound_card_ready", "compound_backend_confirmed", "compound_phone_presented",
    "offer_conflict", "prepare_conflict", "conflict_card_ready", "conflict_returned",
    "offer_uncertainty", "prepare_uncertainty", "uncertainty_card_ready", "uncertainty_held",
  ] as const;
  return events.reduce((state, type) => reduceFamilyThread(state, { type } as never), initialFamilyThreadState);
}

describe("R5 closing proof moment", () => {
  it("keeps S8 behind an explicit visitor continuation", () => {
    const held = reachHeldState();
    expect(held.stage).toBe("uncertainty_held");
    expect(reduceFamilyThread({ stage: "compound_confirmed" }, { type: "continue_to_closing" } as never).stage).toBe("compound_confirmed");
    expect(reduceFamilyThread(held, { type: "time_elapsed", milliseconds: 30_000 }).stage).toBe("uncertainty_held");
    expect(reduceFamilyThread(held, { type: "continue_to_closing" } as never).stage).toBe("closing");
    expect(app).toContain('flow.stage === "closing"');
  });

  it("pins the quiet closing hierarchy and the real-but-fictional disclosure", () => {
    for (const copy of [
      "REAL SERVICES · FICTIONAL TEST DATA",
      "This is the OpenClaw I’d actually give my parents.",
      "Ask freely. Approve changes. Bander keeps the keys—and tells the truth about what happened.",
      "The same boundary shown here has run against real Google Calendar, Gmail, Telegram, and GPT‑5.6 Sol.",
    ]) expect(publicSurface).toContain(copy);
  });

  it("shows exactly the three curated evidence images without cropping", () => {
    for (const image of ["real-read-two-identities.png", "real-compound-family.png", "real-changed-world.png"]) {
      expect(publicSurface).toContain(image);
    }
    expect(styles).toMatch(/\.closing-evidence[^}]*object-fit:\s*contain/s);
    expect(styles).not.toMatch(/\.closing-evidence[^}]*object-fit:\s*cover/s);
  });

  it("offers the four restrained closing actions and an accessible static lightbox", () => {
    for (const copy of ["Evidence ledger", "Public repository", "Try the sandbox again", "Setup guide"]) expect(publicSurface).toContain(copy);
    expect(publicSurface).toContain('className="evidence-lightbox"');
    expect(publicSurface).toContain("Close enlarged evidence");
  });

  it("keeps the final OG image fictional, legible, and tied to the S5 completion", () => {
    expect(fs.existsSync(ogSourcePath)).toBe(true);
    const source = fs.existsSync(ogSourcePath) ? fs.readFileSync(ogSourcePath, "utf8") : "";
    expect(source).toContain('width="1200" height="630"');
    expect(source).toContain("REAL SERVICES · FICTIONAL TEST DATA");
    expect(source).toContain("Add it to my calendar and let Gil know.");
    expect(source).toContain("Done exactly as approved");
    expect(source).toContain("GIL’S PHONE");
  });
});

describe("R6 motion and accessibility finish", () => {
  it("keeps hands-off time inert in both episode and product surfaces", () => {
    const held = reachHeldState();
    expect(reduceFamilyThread(held, { type: "time_elapsed", milliseconds: 30_000 })).toEqual(held);
    expect(surfaces).not.toContain("setInterval(");
  });

  it("preserves Cross Return and Hold semantics with reduced motion", () => {
    const reducedMotionRules = styles.match(/@media \(prefers-reduced-motion: reduce\)[\s\S]*$/)?.[0] ?? "";
    expect(app).toContain('reducedMotion ? 0 : R2_PRESENTATION_BEAT_MS');
    expect(styles).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*animation-duration:\s*0\.01ms/);
    expect(reducedMotionRules).toContain('.deal-marker[data-marker-state="crossed"]');
    expect(reducedMotionRules).toContain('.deal-marker[data-marker-state="returned"]');
    expect(reducedMotionRules).toContain('.deal-marker[data-marker-state="held"]');
  });

  it("uses only transform and opacity for the new closing motion", () => {
    const closingRules = styles.match(/\/\* R5\/R6[\s\S]*$/)?.[0] ?? "";
    expect(closingRules).not.toMatch(/animation[^;]*(?:width|height|left|top|box-shadow)/);
    expect(closingRules).not.toMatch(/bounce|elastic|parallax|pulse/i);
  });

  it("keeps terminal announcements singular and deep links independently named", () => {
    expect(app.match(/role="log"/g)).toHaveLength(1);
    expect(app).toContain('aria-relevant="additions text"');
    expect(app).toContain("Bander family conversation sandbox");
  });
});
