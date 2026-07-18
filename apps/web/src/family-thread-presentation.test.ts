import fs from "node:fs";
import { describe, expect, it } from "vitest";

const app = fs.readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const styles = fs.readFileSync(new URL("./styles.css", import.meta.url), "utf8");

describe("R1 Family Thread presentation contract", () => {
  it("makes the default shell a parent conversation rather than a landing page", () => {
    expect(app).toContain("The assistant you can hand to your parents.");
    expect(app).toContain("What did Dr. Rao’s office say?");
    expect(app).toContain("Tap to ask — you drive everything here.");
    expect(app).toContain("Reading never crosses the line.");
    expect(app).toContain("Add it to my calendar and let Gil know.");
    expect(app).toContain("<FamilyThread");
  });

  it("gives the Line and three seeded world objects semantic state", () => {
    expect(app).toContain('aria-label={`Bander Line: ${lineState}`}');
    expect(app).toContain('data-line-state={lineState}');
    expect(app).toContain("Calendar");
    expect(app).toContain("Inbox");
    expect(app).toContain("Gil’s phone");
    expect(app).toContain("SANDBOX");
  });

  it("uses a modal Card without changing the existing Card actions", () => {
    expect(app).toContain('role="dialog"');
    expect(app).toContain('aria-modal="true"');
    expect(app).toContain("Do exactly this");
    expect(app).toContain("Not now");
    expect(app).toContain("inert={cardActive}");
  });

  it("keeps the parent-facing Card heading visible and the mobile approval hierarchy intact", () => {
    expect(styles).not.toContain(".deal-modal .embedded-deal .deal-heading { display: none; }");
    expect(styles).toMatch(/\.deal-modal \.embedded-deal \.deal-heading\s*\{[^}]*display:\s*block/s);
    expect(styles).toMatch(/@media \(max-width: 640px\)[\s\S]*?\.deal-modal \.actions\s*\{[^}]*grid-template-columns:\s*1fr/s);
    expect(styles).toMatch(/@media \(max-width: 640px\)[\s\S]*?\.deal-modal \.actions \.primary\s*\{[^}]*white-space:\s*nowrap/s);
  });

  it("uses the quiet truth ribbon, one product whisper, and an ownable idle gate", () => {
    expect(app).toContain("Seeded browser data");
    expect(app).toContain("Cannot touch real accounts or services");
    expect(app).toContain("Same Bander authority engine and Card rendering");
    expect(app).not.toContain('screen.kind === "welcome" ? "A calm boundary for family AI"');
    expect(app).toContain('className="line-seal"');
    expect(app).not.toContain(': "BANDER LINE"');
  });

  it("keeps announcement focus non-visual without leaving a clipped Card ornament", () => {
    expect(styles).toMatch(/\.authoritative-outcome:focus[^\{]*\{[^}]*outline:\s*none/s);
    expect(styles).not.toContain(".deal-modal .deal-card::before");
    expect(styles).toContain("button:focus-visible, a:focus-visible");
  });

  it("defines a compact R1 token layer and reduced-motion equivalent", () => {
    for (const token of ["--r1-paper", "--r1-teal", "--r1-red", "--r1-line-width", "--r1-motion-fast", "--r1-radius-bubble"]) {
      expect(styles).toContain(token);
    }
    expect(styles).toContain("prefers-reduced-motion: reduce");
    expect(styles).toContain(".family-thread-shell");
    expect(styles).toContain(".bander-line");
    expect(styles).toContain(".world-dock");
  });

  it("scopes family delivery to sending without claiming device receipt or human reading", () => {
    expect(app).not.toMatch(/Gil(?:’s phone)?[^\n<]{0,100}\b(?:received|got|read|saw)\b/i);
    expect(app).not.toMatch(/No family update (?:received|got|read|seen)\./i);
    expect(app).toContain("Bander sent the exact approved update to Gil.");
    expect(app).toContain('detail={compoundPhoneCrossed ? "Update sent"');
    expect(app).toContain('aria-label="Exact approved sandbox update sent to Gil"');
    expect(app).toContain("No family update sent.");
  });
});
