import fs from "node:fs";
import { describe, expect, it } from "vitest";

const read = (file: string) => fs.readFileSync(file, "utf8");

describe("final Pages corrections", () => {
  const packageJson = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
  const app = read("apps/web/src/App.tsx");
  const workflow = read(".github/workflows/pages.yml");
  const cleanClone = read("scripts/verify-clean-clone.ts");

  it("makes the judge-facing Pages verifier build its own artifact exactly once", () => {
    expect(packageJson.scripts["verify:pages"]).toBe(
      "npm run build:pages && npm run verify:pages:artifact && npm run verify:pages:parity",
    );
    expect(workflow.match(/npm run build:pages/g) ?? []).toHaveLength(0);
    expect(workflow.match(/npm run verify:pages/g) ?? []).toHaveLength(1);
    expect(cleanClone.match(/run\("npm", \["run", "build:pages"\]/g) ?? []).toHaveLength(0);
    expect(cleanClone.match(/run\("npm", \["run", "verify:pages"\]/g) ?? []).toHaveLength(1);
  });

  it("gives the three primary lanes explicit concise accessible names", () => {
    expect(app).toContain('aria-label="Just ask"');
    expect(app).toContain('aria-label="Approve a change"');
    expect(app).toContain('aria-label="When Bander isn’t sure"');
  });

  it("routes the guided final outcome to the real setup evidence", () => {
    expect(app).toContain("See how this works for real →");
    expect(app).toContain("https://github.com/gowtham0992/bander#real-services-and-evidence");
  });
});
