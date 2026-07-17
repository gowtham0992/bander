import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scanPagesArtifact } from "./pages-artifact-lib.js";

const roots: string[] = [];

function artifact(script = "safe browser code"): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bander-pages-artifact-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, "assets"));
  fs.writeFileSync(path.join(root, "assets", "app.js"), script);
  fs.writeFileSync(path.join(root, "assets", "app.css"), "body { color: #123; }");
  fs.writeFileSync(path.join(root, "bander-og.png"), "fictional-image");
  fs.writeFileSync(path.join(root, "index.html"), `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'self'; connect-src 'none'"><meta property="og:image" content="/bander/bander-og.png"><link rel="stylesheet" href="/bander/assets/app.css"><script type="module" src="/bander/assets/app.js"></script>`);
  return root;
}

afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe("GitHub Pages artifact boundary", () => {
  it("accepts a browser-only, base-path-correct artifact", () => {
    expect(scanPagesArtifact(artifact()).scripts).toEqual(["/bander/assets/app.js"]);
  });

  it("fails when a fake token-shaped value reaches dist", () => {
    const fakeKey = ["sk", "a".repeat(32)].join("-");
    expect(() => scanPagesArtifact(artifact(`const value = '${fakeKey}';`))).toThrow(/OpenAI-style key/);
  });

  it("fails when a production integration marker reaches dist", () => {
    expect(() => scanPagesArtifact(artifact("import '/apps/broker/src/server.js';"))).toThrow(/forbidden product marker/);
  });

  it("fails when a product runtime host reaches dist", () => {
    expect(() => scanPagesArtifact(artifact("fetch('https://api.telegram.org');"))).toThrow(/forbidden runtime host/);
  });
});
