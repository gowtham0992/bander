import { readFileSync } from "node:fs";
import type { DraftFixture } from "@bander/core";

interface DraftFixturesFile {
  version: 1;
  fixtures: DraftFixture[];
}

export function loadDraftFixtures(): Map<string, DraftFixture> {
  const fixtureUrl = new URL("../../../fixtures/v1/drafts.json", import.meta.url);
  const parsed = JSON.parse(readFileSync(fixtureUrl, "utf8")) as DraftFixturesFile;
  return new Map(parsed.fixtures.map((fixture) => [fixture.id, fixture]));
}
