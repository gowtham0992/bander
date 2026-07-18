import fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
  SETUP_STATIONS,
  VERIFIED_OUTCOMES,
  initialProductSurfaceState,
  reduceProductSurface,
} from "./family-thread-surfaces.js";

const app = fs.readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const surfaces = fs.readFileSync(new URL("./family-thread-surface-view.tsx", import.meta.url), "utf8");
const publicSurface = `${app}\n${surfaces}`;
const styles = fs.readFileSync(new URL("./styles.css", import.meta.url), "utf8");

describe("R3 proof drawer and persistent world", () => {
  it("replaces the legacy scenario grid with one proof drawer control", () => {
    expect(publicSurface).toContain("All 27 verified outcomes");
    expect(app).toContain('<section className="thread-continuation"');
    expect(app).not.toContain("<Welcome");
  });

  it("keeps every verified outcome reachable in two actions or fewer", () => {
    expect(VERIFIED_OUTCOMES).toHaveLength(27);
    expect(new Set(VERIFIED_OUTCOMES.map((outcome) => outcome.routeId))).toEqual(new Set([
      "schedule", "inbox", "exact", "conflict", "compound", "ambiguous", "create", "cancel",
      "cancel-conflict", "email", "email-thread", "email-ambiguous", "direct-family", "standing",
    ]));
    expect(VERIFIED_OUTCOMES.every((outcome) => outcome.sentence.length > 20)).toBe(true);
  });

  it("opens and closes the proof surface explicitly without time advancing it", () => {
    const open = reduceProductSurface(initialProductSurfaceState, { type: "open_proof" });
    expect(open.proof).toBe("open");
    expect(reduceProductSurface(open, { type: "time_elapsed", milliseconds: 30_000 })).toEqual(open);
    expect(reduceProductSurface(open, { type: "close_proof" }).proof).toBe("closed");
  });

  it("keeps seeded world details truthful about sending", () => {
    expect(app).toContain("Open seeded Calendar details");
    expect(app).toContain("Open seeded Sent Mail details");
    expect(app).toContain("Open seeded Gil update details");
    expect(publicSurface).not.toMatch(/Gil(?:’s phone)?[^\n<]{0,100}\b(?:received|got|read|saw)\b/i);
  });
});

describe("R4 visitor-controlled comparison and setup rail", () => {
  it("advances the comparison only through visitor events", () => {
    const opened = reduceProductSurface(initialProductSurfaceState, { type: "open_comparison" });
    expect(opened.comparison).toBe("beat_1");
    expect(reduceProductSurface(opened, { type: "time_elapsed", milliseconds: 30_000 })).toEqual(opened);
    const beat2 = reduceProductSurface(opened, { type: "next_comparison_beat" });
    expect(beat2.comparison).toBe("beat_2");
    expect(reduceProductSurface(beat2, { type: "next_comparison_beat" }).comparison).toBe("beat_3");
  });

  it("pins the fair three-beat comparison and full five-row continuation", () => {
    expect(publicSurface).toContain("Doesn’t OpenClaw already do approvals?");
    expect(publicSurface).toContain("Approvals gate the hand.");
    expect(publicSurface).toContain("Bander moves the keys across the line.");
    expect(publicSurface).toContain("And binds every yes to the world she actually saw.");
    expect(publicSurface).toContain("Full comparison");
  });

  it("uses the exact five setup stations and valid SETUP anchors", () => {
    expect(SETUP_STATIONS.map((station) => station.title)).toEqual([
      "Try the hosted sandbox",
      "Create two Telegram bots",
      "Connect a dedicated Google account",
      "Pair the parent’s Telegram group",
      "Invite one family member",
    ]);
    const setup = fs.readFileSync(new URL("../../../SETUP.md", import.meta.url), "utf8");
    const anchors = new Set([...setup.matchAll(/^#{1,6}\s+(.+)$/gm)].map(([, heading]) => `#${heading!.toLowerCase().replace(/[^a-z0-9 -]/g, "").trim().replace(/\s+/g, "-")}`));
    for (const station of SETUP_STATIONS) expect(anchors.has(station.anchor)).toBe(true);
    expect(publicSurface).toContain("About 45 minutes once. Fully reversible. Runs beside an isolated OpenClaw profile.");
  });

  it("keeps the old comparison table and setup accordion off the rendered main page", () => {
    expect(app).toContain("{screen.kind === \"welcome\" && <FamilyThread />}");
    expect(app).not.toContain("{screen.kind === \"welcome\" && <Welcome");
    expect(publicSurface).toContain('className="comparison-ledger"');
    expect(publicSurface).toContain('className="setup-track"');
  });

  it("supports explicit setup and world sheets with no timer progression", () => {
    const setup = reduceProductSurface(initialProductSurfaceState, { type: "open_setup", stationId: "telegram" });
    expect(setup.setupStation).toBe("telegram");
    const world = reduceProductSurface(setup, { type: "open_world", world: "phone" });
    expect(world.worldSheet).toBe("phone");
    expect(reduceProductSurface(world, { type: "time_elapsed", milliseconds: 30_000 })).toEqual(world);
  });
});
