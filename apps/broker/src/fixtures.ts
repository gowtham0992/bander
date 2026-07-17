import type { DraftFixture } from "@bander/core";
import { versionedDraftFixtures } from "@bander/demo-sandbox";

export function loadDraftFixtures(): Map<string, DraftFixture> {
  return versionedDraftFixtures();
}
