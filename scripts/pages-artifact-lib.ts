import fs from "node:fs";
import path from "node:path";

const SECRET_SHAPES: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: "OpenAI-style key", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { name: "Telegram bot token", pattern: /\b\d{8,}:[A-Za-z0-9_-]{20,}\b/ },
  { name: "private key", pattern: /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/ },
  { name: "OAuth token", pattern: /\"(?:access_token|refresh_token|client_secret)\"\s*:\s*\"[^\"]+\"/i },
];

const FORBIDDEN_PRODUCT_MARKERS = [
  "OPENAI_API_KEY",
  "BANDER_TELEGRAM_BOT_TOKEN",
  "OPENCLAW_TELEGRAM_BOT_TOKEN",
  "GOOGLE_OAUTH_CLIENT_PATH",
  "GOOGLE_OAUTH_TOKEN_PATH",
  "GMAIL_OAUTH_CLIENT_PATH",
  "GMAIL_OAUTH_TOKEN_PATH",
  "/apps/broker/",
  "/apps/mock-services/",
  "googleapis",
  "node:crypto",
  "fastify",
] as const;

const FORBIDDEN_NETWORK_HOSTS = [
  "api.openai.com",
  "googleapis.com/calendar",
  "gmail.googleapis.com",
  "api.telegram.org",
] as const;

function filesUnder(root: string): string[] {
  const output: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const candidate = path.join(root, entry.name);
    if (entry.isDirectory()) output.push(...filesUnder(candidate));
    else if (entry.isFile()) output.push(candidate);
  }
  return output;
}

export interface PagesArtifactReport {
  files: number;
  scripts: string[];
  stylesheets: string[];
}

export function scanPagesArtifact(root: string): PagesArtifactReport {
  const resolved = path.resolve(root);
  const indexPath = path.join(resolved, "index.html");
  if (!fs.existsSync(indexPath)) throw new Error("Pages artifact has no index.html");
  const index = fs.readFileSync(indexPath, "utf8");
  if (!index.includes('content="default-src \'self\';')) throw new Error("Pages artifact is missing its static CSP");
  if (!index.includes("connect-src 'none'")) throw new Error("Pages artifact can make runtime connections");
  if (!index.includes("/bander/assets/")) throw new Error("Pages artifact was not built for the /bander/ base path");
  if (!index.includes("/bander/bander-og.png")) throw new Error("Pages artifact is missing its Bander Open Graph image");

  const files = filesUnder(resolved);
  for (const file of files) {
    if (path.basename(file) === ".DS_Store") throw new Error("Pages artifact contains an operating-system metadata file");
    const bytes = fs.readFileSync(file);
    if (bytes.includes(0)) continue;
    const source = bytes.toString("utf8");
    for (const secret of SECRET_SHAPES) {
      if (secret.pattern.test(source)) throw new Error(`Pages artifact contains a ${secret.name}`);
    }
    for (const marker of FORBIDDEN_PRODUCT_MARKERS) {
      if (source.includes(marker)) throw new Error(`Pages artifact contains forbidden product marker: ${marker}`);
    }
    for (const host of FORBIDDEN_NETWORK_HOSTS) {
      if (source.includes(host)) throw new Error(`Pages artifact contains forbidden runtime host: ${host}`);
    }
  }

  const scripts = [...index.matchAll(/<script[^>]+src="([^"]+)"/g)].map((match) => match[1]!);
  const stylesheets = [...index.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/g)].map((match) => match[1]!);
  if (scripts.length !== 1 || stylesheets.length !== 1) throw new Error("Pages artifact has an unexpected executable asset graph");
  return { files: files.length, scripts, stylesheets };
}
