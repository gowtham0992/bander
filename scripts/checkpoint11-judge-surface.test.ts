import fs from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

const read = (file: string) => fs.readFileSync(file, "utf8");

const screenshotAssets = [
  "docs/assets/screenshots/real-compound-family.png",
  "docs/assets/screenshots/real-changed-world.png",
  "docs/assets/screenshots/real-read-two-identities.png",
  "docs/assets/screenshots/bander-social-preview.png",
] as const;

function pngChunkTypes(file: string): string[] {
  const data = fs.readFileSync(file);
  const chunks: string[] = [];
  let offset = 8;
  while (offset + 12 <= data.length) {
    const length = data.readUInt32BE(offset);
    const type = data.toString("ascii", offset + 4, offset + 8);
    chunks.push(type);
    offset += 12 + length;
    if (type === "IEND") break;
  }
  return chunks;
}

describe("Checkpoint 11 judge-facing freeze", () => {
  const readme = read("README.md");
  const app = read("apps/web/src/App.tsx");
  const styles = read("apps/web/src/styles.css");

  it("leads with the parent product, browser CTA, and concise judge path", () => {
    const tagline = readme.indexOf("The OpenClaw I’d actually give my parents.");
    const definition = readme.indexOf("Your assistant can read your calendar and mail and talk like a person.");
    const browserCta = readme.indexOf("Try Bander in your browser — no accounts, nothing real can happen");
    const quickstart = readme.indexOf("Judge quickstart");
    expect(tagline).toBeGreaterThan(-1);
    expect(definition).toBeGreaterThan(tagline);
    expect(browserCta).toBeGreaterThan(definition);
    expect(quickstart).toBeGreaterThan(browserCta);
  });

  it("tells the complete read, email, calendar, family, and uncertainty story", () => {
    expect(readme).toContain("Mum asks what is coming up");
    expect(readme).toContain("exact email reply");
    expect(readme).toContain("Calendar change and the exact sentence Bander may send to Gil");
    expect(readme).toContain("If the Calendar or email changes before approval, Bander stops.");
  });

  it("uses the final five-scene real-evidence story without overstating delivery", () => {
    expect(readme).toContain("After approval, Bander changes the Calendar first, then sends Gil precisely the sentence Mum approved. If the Calendar or email changes before approval, Bander stops.");
    expect(readme).toContain("Our live probe suites passed 49 natural and adversarial cases, with zero false accepts in those runs.");
    expect(readme).toContain("530 functional cases and 26 adversarial cases.");
    expect(readme).not.toMatch(/Gil(?:’s separate phone|’s phone)?\s+(?:receives|reads)\b/i);
  });

  it("explains why Bander complements native approvals", () => {
    expect(readme).toContain("## Why not just native approvals?");
    expect(readme).toContain("Bander does not replace them");
    expect(readme).toContain("Bander moves the credentials themselves");
    expect(readme).toContain("That behavior—not the approval button—is the product.");
  });

  it("uses measured timing without a synthetic range", () => {
    expect(readme).toContain("both measured warm-cache runs completed in 13 seconds");
    expect(readme).not.toContain("observed range: 13–13 seconds");
  });

  it("keeps the public capability list parent-readable and bounded", () => {
    const match = readme.match(/## What a parent can do[\s\S]*?<details>/);
    expect(match).not.toBeNull();
    const bullets = match![0].match(/^-/gm) ?? [];
    expect(bullets.length).toBeLessThanOrEqual(7);
    expect(match![0]).toContain("Ask what is on the calendar");
    expect(match![0]).toContain("Read one matching email");
    expect(match![0]).toContain("Approve an exact family update");
  });

  it("routes completed sandbox outcomes toward real-service evidence", () => {
    expect(app).toContain("See how this works with real services →");
    expect(app).toContain("Bander can also stop when the world changed—or admit when a result cannot be confirmed.");
    expect(app).toContain("Explore those cases below.");
  });

  it("makes the repository the primary footer destination", () => {
    expect(app).toContain('className="repository-link"');
    expect(styles).toContain(".project-links .repository-link");
  });

  it("keeps the seeded and real evidence boundary explicit", () => {
    expect(readme).toContain("The browser experience uses seeded data and cannot contact real services.");
    expect(readme).toContain("real Telegram, Google Calendar, Gmail, OpenClaw, and GPT‑5.6 integration using fictional test data");
  });

  it("ships the curated real-product screenshot set with README links", () => {
    for (const asset of screenshotAssets) {
      expect(fs.existsSync(asset), `${asset} should exist`).toBe(true);
      expect(pngChunkTypes(asset)).not.toEqual(expect.arrayContaining(["eXIf", "tEXt", "zTXt", "iTXt"]));
    }
    const asset = "docs/assets/media/telegram-real-product-loop.gif";
    expect(readme).toContain(asset);
    expect(readme.match(/docs\/assets\/media\/telegram-real-[^)\s]+\.gif/g)).toEqual([asset]);
    expect(fs.existsSync(asset)).toBe(true);
    const gif = fs.readFileSync(asset);
    expect(gif.subarray(0, 6).toString("ascii")).toBe("GIF89a");
    expect(gif.readUInt16LE(6)).toBe(1000);
    expect(gif.readUInt16LE(8)).toBe(900);
    expect(gif.byteLength).toBe(1_220_012);
    expect(createHash("sha256").update(gif).digest("hex")).toBe(
      "48d1c3143af0c16025c2426496c76475bf74ca14a4a4ec5da3a580c0a3525aa1",
    );
    expect(readme).toContain("Five full-screen real Bander integration captures using fictional test data: a free Calendar read, one exact Calendar-and-family deal, the approved update visible on Gil’s separate phone, a changed-world refusal, and one exact Gmail reply.");
    expect(readme).toContain("Five real moments: a bounded read, one exact Calendar-and-family deal, Bander’s approved update visible on Gil’s separate phone, a changed-world refusal, and an exact Gmail reply. The full Telegram context is preserved in every frame.");
  });

  it("records the visible screenshot evidence label and privacy review", () => {
    const manifest = JSON.parse(read("docs/assets/screenshots/manifest.json")) as {
      label?: string;
      manualPrivacyReview?: boolean;
      assets?: Array<Record<string, unknown>>;
    };
    expect(manifest.label).toBe("REAL INTEGRATION · FICTIONAL TEST DATA");
    expect(manifest.manualPrivacyReview).toBe(true);
    expect(manifest.assets).toEqual(expect.arrayContaining(
      screenshotAssets.map((asset) => expect.objectContaining({ file: asset.split("/").at(-1) })),
    ));
    expect(manifest.assets).toContainEqual(expect.objectContaining({
      file: "../media/telegram-real-product-loop.gif",
      width: 1000,
      height: 900,
      durationSeconds: 18.8,
      frames: 5,
      bytes: 1_220_012,
      sha256: "48d1c3143af0c16025c2426496c76475bf74ca14a4a4ec5da3a580c0a3525aa1",
    }));
  });
});
