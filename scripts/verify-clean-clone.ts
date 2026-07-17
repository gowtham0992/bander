import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

const TEMPORARY_PREFIX = "/private/tmp/bander-clean-clone-";
const PRODUCT_SECRET_KEYS = [
  "OPENAI_API_KEY",
  "BANDER_TELEGRAM_BOT_TOKEN",
  "OPENCLAW_TELEGRAM_BOT_TOKEN",
  "GOOGLE_OAUTH_CLIENT_PATH",
  "GOOGLE_OAUTH_TOKEN_PATH",
  "GMAIL_OAUTH_CLIENT_PATH",
  "GMAIL_OAUTH_TOKEN_PATH",
  "BANDER_TELEGRAM_STATE_PATH",
  "BANDER_TELEGRAM_PAIRING_PATH",
  "BANDER_FAMILY_PAIRING_PATH",
] as const;

interface CommandResult {
  stdout: string;
  stderr: string;
}

function run(
  command: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; timeout?: number },
): CommandResult {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
    shell: false,
    timeout: options.timeout ?? 180_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const diagnostic = `${result.stdout}\n${result.stderr}`
      .replace(/\/private\/tmp\/bander-clean-clone-[^/\s]+/g, "<isolated-clone>")
      .replace(/(?:sk-[A-Za-z0-9_-]{8,}|[0-9]{8,}:[A-Za-z0-9_-]{8,})/g, "[redacted]")
      .trim()
      .slice(-1_500);
    throw new Error(
      `${command} ${args[0] ?? ""} failed (${result.status ?? "timeout"})${diagnostic ? `\n${diagnostic}` : ""}`,
    );
  }
  return { stdout: result.stdout, stderr: result.stderr };
}

function trackedAndProposedFiles(cwd: string): string[] {
  return run(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd },
  ).stdout.split("\0").filter(Boolean);
}

function copyCurrentCheckout(source: string, destination: string): void {
  for (const relative of trackedAndProposedFiles(source)) {
    if (relative === ".git" || relative.startsWith(".git/")) continue;
    const from = path.join(source, relative);
    const to = path.join(destination, relative);
    const stat = fs.lstatSync(from);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    if (stat.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(from), to);
    else fs.copyFileSync(from, to, fs.constants.COPYFILE_FICLONE);
  }
  run("git", ["add", "-A"], { cwd: destination });
  run("git", ["-c", "user.name=Bander Clean Clone", "-c", "user.email=clean-clone@invalid", "commit", "-m", "ephemeral clean-clone verification"], { cwd: destination });
}

function assertNoPrivateArtifacts(cwd: string): void {
  const forbidden = [
    ".env",
    ".bander",
    "transcription1.md",
    "transcription_day2.md",
  ];
  for (const candidate of forbidden) {
    if (fs.existsSync(path.join(cwd, candidate))) {
      throw new Error("The isolated clone contains a private local artifact");
    }
  }
  const files = trackedAndProposedFiles(cwd);
  if (files.some((file) => /\.(?:png|jpe?g|webp)$/i.test(file))) {
    throw new Error("The isolated clone contains a personal or generated screenshot");
  }
  if (!fs.existsSync(path.join(cwd, "LICENSE"))) {
    throw new Error("The isolated clone has no MIT license file");
  }
  const license = fs.readFileSync(path.join(cwd, "LICENSE"), "utf8");
  if (!license.includes("MIT License")) throw new Error("The repository license is not MIT");
}

function assertNoSecretShapedTrackedContent(cwd: string): void {
  const result = spawnSync(
    "rg",
    [
      "-n",
      "--hidden",
      "--glob",
      "!.git/**",
      "--glob",
      "!package-lock.json",
      "(?:sk-[A-Za-z0-9_-]{20,}|[0-9]{8,}:[A-Za-z0-9_-]{20,}|-----BEGIN (?:RSA |EC |)PRIVATE KEY-----)",
      ".",
    ],
    { cwd, encoding: "utf8", shell: false },
  );
  if (result.status === 0) throw new Error("Tracked content contains a secret-shaped value");
  if (result.status !== 1) throw new Error("The tracked-secret scan could not run");
}

function assertLocalDocumentationLinks(cwd: string): void {
  const markdownFiles = trackedAndProposedFiles(cwd).filter((file) => file.endsWith(".md"));
  for (const file of markdownFiles) {
    const source = fs.readFileSync(path.join(cwd, file), "utf8");
    for (const match of source.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      const raw = match[1]?.trim();
      if (!raw || /^(?:https?:|mailto:|#)/.test(raw)) continue;
      const withoutAnchor = raw.split("#", 1)[0]!;
      const decoded = decodeURIComponent(withoutAnchor.replace(/^<|>$/g, ""));
      const target = path.resolve(cwd, path.dirname(file), decoded);
      if (!fs.existsSync(target)) throw new Error("A local documentation link is broken");
    }
  }
}

function sanitizedProductEnvironment(blockProductNetwork = true): NodeJS.ProcessEnv {
  const sanitizedEnvironment: NodeJS.ProcessEnv = { ...process.env };
  delete sanitizedEnvironment.OPENAI_API_KEY;
  delete sanitizedEnvironment.BANDER_TELEGRAM_BOT_TOKEN;
  delete sanitizedEnvironment.OPENCLAW_TELEGRAM_BOT_TOKEN;
  delete sanitizedEnvironment.GOOGLE_OAUTH_CLIENT_PATH;
  delete sanitizedEnvironment.GOOGLE_OAUTH_TOKEN_PATH;
  delete sanitizedEnvironment.GMAIL_OAUTH_CLIENT_PATH;
  delete sanitizedEnvironment.GMAIL_OAUTH_TOKEN_PATH;
  delete sanitizedEnvironment.BANDER_TELEGRAM_STATE_PATH;
  delete sanitizedEnvironment.BANDER_TELEGRAM_PAIRING_PATH;
  delete sanitizedEnvironment.BANDER_FAMILY_PAIRING_PATH;
  for (const key of PRODUCT_SECRET_KEYS) delete sanitizedEnvironment[key];
  if (blockProductNetwork) {
    sanitizedEnvironment.HTTP_PROXY = "http://127.0.0.1:9";
    sanitizedEnvironment.HTTPS_PROXY = "http://127.0.0.1:9";
    sanitizedEnvironment.ALL_PROXY = "http://127.0.0.1:9";
    sanitizedEnvironment.NO_PROXY = "127.0.0.1,localhost";
  }
  return sanitizedEnvironment;
}

async function reserveDistinctPorts(count: number): Promise<number[]> {
  const servers: net.Server[] = [];
  try {
    for (let index = 0; index < count; index += 1) {
      const server = net.createServer();
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      servers.push(server);
    }
    return servers.map((server) => {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Could not reserve an isolated local port");
      }
      return address.port;
    });
  } finally {
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  }
}

async function waitForHttp(url: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("The zero-account demo stopped during startup");
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("The zero-account demo did not start");
}

async function proveDemoStarts(cwd: string, environment: NodeJS.ProcessEnv): Promise<void> {
  const child = spawn("npm", ["run", "demo"], {
    cwd,
    env: environment,
    shell: false,
    stdio: "ignore",
    detached: true,
  });
  try {
    await waitForHttp(`http://127.0.0.1:${environment.BANDER_PORT}/api/status`, child);
    const origin = `http://127.0.0.1:${environment.BANDER_PORT}`;
    const page = await fetch(`${origin}/`).then((response) => response.text());
    const assetPaths = [...page.matchAll(/<script[^>]+src="([^"]+)"/g)]
      .map((match) => match[1])
      .filter((asset): asset is string => Boolean(asset));
    const assets = await Promise.all(
      assetPaths.map((asset) => fetch(new URL(asset, origin)).then((response) => response.text())),
    );
    if (!assets.some((asset) => asset.includes("Deterministic sandbox") && asset.includes("does not connect to Google, Telegram, or OpenAI"))) {
      throw new Error("The sandbox is not visibly labelled deterministic and non-live");
    }
  } finally {
    if (child.pid) process.kill(-child.pid, "SIGTERM");
  }
}

function safeCleanup(directory: string): void {
  const resolved = path.resolve(directory);
  if (!resolved.startsWith(TEMPORARY_PREFIX) || resolved === TEMPORARY_PREFIX.slice(0, -1)) {
    throw new Error("Refusing cleanup outside the generated clean-clone directory");
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}

export async function verifyCleanClone(source = process.cwd()): Promise<void> {
  const temporary = fs.mkdtempSync(TEMPORARY_PREFIX);
  const clone = path.join(temporary, "repository");
  try {
    run("git", ["clone", "--quiet", "--no-hardlinks", source, clone], { cwd: temporary });
    copyCurrentCheckout(source, clone);
    assertNoPrivateArtifacts(clone);
    assertNoSecretShapedTrackedContent(clone);
    assertLocalDocumentationLinks(clone);

    run("npm", ["ci", "--ignore-scripts"], {
      cwd: clone,
      env: sanitizedProductEnvironment(false),
      timeout: 300_000,
    });
    const environment = sanitizedProductEnvironment();
    const [brokerPort, mockPort, webPort] = await reserveDistinctPorts(3);
    Object.assign(environment, {
      BANDER_PORT: String(brokerPort),
      MOCK_SERVICE_PORT: String(mockPort),
      WEB_PORT: String(webPort),
      BANDER_URL: `http://127.0.0.1:${brokerPort}`,
    });
    run("npm", ["run", "typecheck"], { cwd: clone, env: environment });
    run("npm", ["run", "build"], { cwd: clone, env: environment });
    const doctor = run("npm", ["run", "doctor"], { cwd: clone, env: environment });
    if (!doctor.stdout.includes("Copy .env.example to .env") || doctor.stdout.includes("Error:")) {
      throw new Error("The no-account doctor was not actionable");
    }
    const demo = run("npm", ["run", "verify:demo"], { cwd: clone, env: environment });
    const parsedStart = demo.stdout.lastIndexOf("{");
    const outcomes = parsedStart >= 0 ? JSON.parse(demo.stdout.slice(parsedStart)) as Record<string, string> : {};
    if (Object.keys(outcomes).length !== 27 || Object.values(outcomes).some((value) => value === "unexpected")) {
      throw new Error("The deterministic demo did not report 27 green outcomes");
    }
    await proveDemoStarts(clone, environment);
    if (run("git", ["status", "--porcelain"], { cwd: clone }).stdout !== "") {
      throw new Error("The isolated verification changed the repository working tree");
    }
    process.stdout.write(
      [
        "Clean-clone acceptance: PASS",
        "- no credentials, generated state, transcripts, or screenshots",
        "- npm ci, typecheck, and production build passed",
        "- no-account doctor reported actionable real-setup gaps",
        "- deterministic sandbox started without accounts",
        "- 27 of 27 demo outcomes passed",
        "- no Google, Telegram, or OpenAI product endpoint was reachable",
        "- isolated working tree remained clean",
      ].join("\n") + "\n",
    );
  } finally {
    safeCleanup(temporary);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  await verifyCleanClone();
}
