import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { scanPagesArtifact } from "./pages-artifact-lib.js";

const root = path.resolve("apps/web/dist-pages");
const report = scanPagesArtifact(root);

function typeFor(file: string): string {
  if (file.endsWith(".js")) return "text/javascript";
  if (file.endsWith(".css")) return "text/css";
  if (file.endsWith(".svg")) return "image/svg+xml";
  if (file.endsWith(".png")) return "image/png";
  return "text/html";
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (!url.pathname.startsWith("/bander/")) { response.writeHead(404).end(); return; }
  const relative = url.pathname === "/bander/" ? "index.html" : url.pathname.slice("/bander/".length);
  const candidate = path.resolve(root, relative);
  if (!candidate.startsWith(`${root}${path.sep}`) || !fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) { response.writeHead(404).end(); return; }
  response.writeHead(200, { "content-type": typeFor(candidate) });
  response.end(fs.readFileSync(candidate));
});

await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
try {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Pages verifier could not reserve a local port");
  const origin = `http://127.0.0.1:${address.port}`;
  for (const scenario of ["compound", "email", "email-ambiguous", "standing"]) {
    const response = await fetch(`${origin}/bander/?scenario=${scenario}`);
    if (!response.ok || !(await response.text()).includes("Bander — Ask freely. Approve changes.")) throw new Error(`Pages direct refresh failed for ${scenario}`);
  }
  for (const asset of [...report.scripts, ...report.stylesheets]) {
    const response = await fetch(`${origin}${asset}`);
    if (!response.ok) throw new Error(`Pages static asset is unavailable: ${asset}`);
  }
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

console.log(`Pages artifact verified: ${report.files} files; /bander/ direct refresh and seeded scenarios are ready.`);
