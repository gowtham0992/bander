import fs from "node:fs";
import { describe, expect, it } from "vitest";

const read = (file: string) => fs.readFileSync(file, "utf8");

describe("Checkpoint 12 judge surfaces", () => {
  const app = read("apps/web/src/App.tsx");
  const telegram = read("apps/broker/src/telegram-service.ts");
  const core = read("packages/core/src/card.ts");
  const readme = read("README.md");
  const vite = read("apps/web/vite.config.ts");

  it("pins calm truth-scoped parent Telegram copy", () => {
    expect(telegram).toContain("Bander hasn’t done anything yet — please check:");
    expect(telegram).toContain("Your assistant says you asked:");
    expect(telegram).toContain("If you say yes, Bander will check the latest information. If it still matches, Bander will:");
    expect(telegram).toContain("Bander won’t do anything else.");
    expect(telegram).toContain("Bander moved nothing and sent nothing.");
    expect(telegram).toContain("Bander didn’t message anyone");
    expect(telegram).not.toContain('"Nothing has happened yet. Is this right?"');
    expect(telegram).not.toContain('"OpenClaw says you asked:"');
    expect(telegram).not.toContain('"Through Bander, this will:"');
    expect(telegram).not.toContain('"No one was messaged."');
  });

  it("removes internal family headers and uses the approved-word-for-word statement", () => {
    expect(core).not.toContain('"EXACT UPDATE FROM BANDER"');
    expect(core).toContain('"Approved word-for-word before Bander sent it."');
  });

  it("orders the cold-visitor narrative around the guided episode", () => {
    const welcome = app.slice(app.indexOf("function Welcome("));
    const order = [
      welcome.indexOf("<HowBanderWorks"),
      welcome.indexOf("Now drive it yourself — one real-life episode, step by step."),
      welcome.indexOf("See more verified examples"),
      welcome.indexOf("The trust boundary"),
      welcome.indexOf("<OpenClawComparison"),
      welcome.indexOf("<TryBander"),
      welcome.indexOf("public-footer"),
    ];
    expect(order.every((position) => position >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((left, right) => left - right));
  });

  it("uses only bundled curated real screenshots in the three-step strip", () => {
    expect(vite).toContain("real-compound-family.png");
    expect(vite).toContain("real-changed-world.png");
    expect(vite).toContain("real-read-two-identities.png");
    expect(app).toContain("1 · Just ask");
    expect(app).toContain("2 · One exact card");
    expect(app).toContain("3 · The truth, either way");
  });

  it("pins the fair factual OpenClaw comparison", () => {
    for (const copy of [
      "Doesn’t OpenClaw already have approvals?",
      "The configured tool or connector holds them within the agent’s execution environment.",
      "The exact tool call and parameters held for approval.",
      "Behavior depends on the connector’s recovery and reporting policy.",
      "One separately consented contact; its destination is bound outside the agent and the exact text requires approval.",
    ]) expect(app).toContain(copy);
    expect(app).not.toContain("nothing to leak");
  });

  it("registers and links every verified example destination", () => {
    for (const scenario of [
      "schedule", "inbox", "exact", "conflict", "compound", "ambiguous",
      "create", "cancel", "cancel-conflict", "email", "email-thread",
      "email-ambiguous", "direct-family", "standing",
    ]) expect(app).toContain(`id: "${scenario}"`);
    expect(app).toContain("See more verified examples");
    expect(app).not.toContain("nonexistent-scenario");
  });

  it("keeps setup orientation static and points to the canonical guide", () => {
    for (const copy of [
      "Try the hosted browser sandbox",
      "Clone and run the local sandbox",
      "Set up the real parent-and-family product",
      "Clone Bander",
      "Create two Telegram bots",
      "Connect a dedicated Google account",
      "Pair the parent’s private group",
      "Invite one family member",
    ]) expect(app).toContain(copy);
    expect(app).toContain('"#1-prepare-the-setup-computer"');
    expect(app).not.toMatch(/<form[^>]+setup/i);
  });

  it("adds a compact factual Build Week judge block without placeholders", () => {
    expect(readme).toContain("## For Build Week judges");
    expect(readme).toContain("**Category:** Apps for Your Life");
    expect(readme).toContain("The required `/feedback` Codex Session ID is supplied through Devpost.");
    expect(readme).not.toMatch(/video coming soon|demo video:\s*(?:$|\[\]\(\))/im);
    expect(readme).not.toContain("demo-video-link");
  });

  it("keeps the absolute static security and five-tool boundaries", () => {
    expect(read("apps/web/index.html")).toContain("connect-src 'none'");
    expect(read("apps/web/index.html")).toContain("frame-src 'none'");
    expect(readme).toContain("exactly five tools");
  });
});
