import fs from "node:fs";
import path from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const pagesBuild = process.env.BANDER_PAGES_BUILD === "1";

function pagesImportBoundary(): Plugin {
  return {
    name: "bander-pages-import-boundary",
    generateBundle() {
      const forbidden = [
        "/apps/broker/",
        "/apps/mock-services/",
        "/scripts/",
        "/node_modules/googleapis/",
        "/node_modules/openai/",
        "/node_modules/fastify/",
        "/packages/core/src/platform-node.ts",
      ];
      const violations = [...this.getModuleIds()].filter((id) =>
        forbidden.some((fragment) => id.replaceAll("\\", "/").includes(fragment)),
      );
      if (violations.length > 0) {
        this.error(`Production-only module reached the Pages graph: ${violations.join(", ")}`);
      }
    },
  };
}

function approvedBrandAssets(): Plugin {
  const assets = [
    { fileName: "bander_mark_transparent.svg", sourcePath: path.resolve("../../production/bander_mark_transparent.svg") },
    { fileName: "bander_favicon_1783950200580.svg", sourcePath: path.resolve("../../production/bander_favicon_1783950200580.svg") },
    { fileName: "bander-og.png", sourcePath: path.resolve("../../docs/assets/screenshots/bander-social-preview.png") },
  ];
  return {
    name: "bander-approved-brand-assets",
    buildStart() {
      for (const asset of assets) {
        const source = fs.readFileSync(asset.sourcePath);
        this.emitFile({ type: "asset", fileName: asset.fileName, source });
      }
    },
  };
}

export default defineConfig({
  base: pagesBuild ? "/bander/" : "/",
  plugins: [react(), approvedBrandAssets(), ...(pagesBuild ? [pagesImportBoundary()] : [])],
  publicDir: false,
  server: {
    strictPort: true,
    proxy: {
      "/api": "http://127.0.0.1:4310",
    },
  },
  build: {
    target: "es2022",
    sourcemap: true,
    ...(pagesBuild ? { outDir: "dist-pages", emptyOutDir: true } : {}),
  },
});
