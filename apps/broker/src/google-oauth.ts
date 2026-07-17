import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { google } from "googleapis";

type GoogleOAuth2Client = InstanceType<typeof google.auth.OAuth2>;
type GoogleCredentials = Parameters<GoogleOAuth2Client["setCredentials"]>[0];
type GoogleCodeChallengeMethod = NonNullable<
  NonNullable<Parameters<GoogleOAuth2Client["generateAuthUrl"]>[0]>["code_challenge_method"]
>;

export const GOOGLE_CALENDAR_SCOPE =
  "https://www.googleapis.com/auth/calendar.events.owned";

export interface DesktopOAuthClient {
  clientId: string;
  clientSecret: string;
}

export function parseDesktopOAuthClient(value: unknown): DesktopOAuthClient {
  if (!value || typeof value !== "object") {
    throw new Error("A Google Desktop app OAuth client document is required");
  }
  const installed = Reflect.get(value, "installed");
  if (!installed || typeof installed !== "object") {
    throw new Error("A Google Desktop app OAuth client document is required");
  }
  const clientId = Reflect.get(installed, "client_id");
  const clientSecret = Reflect.get(installed, "client_secret");
  const redirectUris = Reflect.get(installed, "redirect_uris");
  if (
    typeof clientId !== "string" ||
    clientId.length < 8 ||
    typeof clientSecret !== "string" ||
    clientSecret.length < 8 ||
    !Array.isArray(redirectUris) ||
    !redirectUris.some(
      (candidate) =>
        typeof candidate === "string" &&
        (candidate === "http://localhost" ||
          candidate === "http://127.0.0.1" ||
          candidate.startsWith("http://localhost:") ||
          candidate.startsWith("http://127.0.0.1:")),
    )
  ) {
    throw new Error("A Google Desktop app OAuth client document is required");
  }
  return { clientId, clientSecret };
}

export function createPkcePair(): {
  codeVerifier: string;
  codeChallenge: string;
} {
  const codeVerifier = randomBytes(64).toString("base64url");
  return {
    codeVerifier,
    codeChallenge: createHash("sha256")
      .update(codeVerifier, "ascii")
      .digest("base64url"),
  };
}

export function readOAuthCallback(
  callbackUrl: string,
  expectedState: string,
): string {
  const url = new URL(callbackUrl);
  const actualState = url.searchParams.get("state") ?? "";
  const expected = Buffer.from(expectedState);
  const actual = Buffer.from(actualState);
  if (
    actual.length !== expected.length ||
    !timingSafeEqual(actual, expected)
  ) {
    throw new Error("Google OAuth state did not match");
  }
  if (url.searchParams.get("error")) {
    throw new Error("Google Calendar access was not authorized");
  }
  const codes = url.searchParams.getAll("code");
  if (codes.length !== 1 || !codes[0]) {
    throw new Error("Google OAuth returned no usable authorization code");
  }
  return codes[0];
}

function readJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writePrivateJson(filePath: string, value: unknown): void {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, filePath);
  fs.chmodSync(filePath, 0o600);
}

function parseStoredCredentials(value: unknown): GoogleCredentials {
  if (!value || typeof value !== "object") {
    throw new Error("Stored Google OAuth credentials are invalid");
  }
  const refreshToken = Reflect.get(value, "refresh_token");
  if (typeof refreshToken !== "string" || refreshToken.length < 20) {
    throw new Error("Stored Google OAuth credentials have no refresh token");
  }
  const credentials: GoogleCredentials = { refresh_token: refreshToken };
  const accessToken = Reflect.get(value, "access_token");
  const expiryDate = Reflect.get(value, "expiry_date");
  const tokenType = Reflect.get(value, "token_type");
  const scope = Reflect.get(value, "scope");
  if (typeof accessToken === "string") credentials.access_token = accessToken;
  if (typeof expiryDate === "number") credentials.expiry_date = expiryDate;
  if (typeof tokenType === "string") credentials.token_type = tokenType;
  if (typeof scope === "string") credentials.scope = scope;
  return credentials;
}

async function openAuthorizationInBrowser(url: string): Promise<void> {
  if (process.platform !== "darwin") {
    throw new Error("Automatic Google OAuth browser launch currently requires macOS");
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn("open", [url], {
      detached: true,
      stdio: "ignore",
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

async function authorizeInteractively(
  desktop: DesktopOAuthClient,
  scopes: readonly string[],
  productLabel: string,
): Promise<{ client: GoogleOAuth2Client; tokens: GoogleCredentials }> {
  const state = randomBytes(32).toString("base64url");
  const pkce = createPkcePair();
  const server = http.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Google OAuth loopback server could not start");
  }
  const redirectUri = `http://127.0.0.1:${address.port}/oauth2callback`;
  const client = new google.auth.OAuth2({
    clientId: desktop.clientId,
    clientSecret: desktop.clientSecret,
    redirectUri,
  });
  const authorizationUrl = client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: [...scopes],
    state,
    code_challenge_method: "S256" as GoogleCodeChallengeMethod,
    code_challenge: pkce.codeChallenge,
  });

  const codePromise = new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Google OAuth authorization timed out"));
      server.close();
    }, 180_000);
    server.on("request", (request, response) => {
      try {
        const callbackUrl = new URL(
          request.url ?? "/",
          `http://${request.headers.host ?? "127.0.0.1"}`,
        );
        if (callbackUrl.pathname !== "/oauth2callback") {
          response.writeHead(404).end("Not found");
          return;
        }
        const code = readOAuthCallback(callbackUrl.toString(), state);
        response
          .writeHead(200, { "content-type": "text/plain; charset=utf-8" })
          .end(`Bander is connected to ${productLabel}. You can close this tab.`);
        clearTimeout(timeout);
        server.close();
        resolve(code);
      } catch (error) {
        response
          .writeHead(400, { "content-type": "text/plain; charset=utf-8" })
          .end("Bander could not complete Google authorization.");
        clearTimeout(timeout);
        server.close();
        reject(error);
      }
    });
  });

  try {
    await openAuthorizationInBrowser(authorizationUrl);
    const code = await codePromise;
    const { tokens } = await client.getToken({
      code,
      codeVerifier: pkce.codeVerifier,
      redirect_uri: redirectUri,
    });
    client.setCredentials(tokens);
    return { client, tokens };
  } finally {
    if (server.listening) server.close();
  }
}

export async function loadGoogleOAuth(options: {
  clientPath: string;
  tokenPath: string;
  scopes: readonly string[];
  productLabel: string;
  exactScopes?: boolean;
}): Promise<GoogleOAuth2Client> {
  const clientPath = path.resolve(options.clientPath);
  const tokenPath = path.resolve(options.tokenPath);
  const desktop = parseDesktopOAuthClient(readJson(clientPath));
  fs.chmodSync(clientPath, 0o600);

  let client: GoogleOAuth2Client;
  let credentials: GoogleCredentials;
  if (fs.existsSync(tokenPath)) {
    credentials = parseStoredCredentials(readJson(tokenPath));
    client = new google.auth.OAuth2({
      clientId: desktop.clientId,
      clientSecret: desktop.clientSecret,
    });
    client.setCredentials(credentials);
  } else {
    const authorized = await authorizeInteractively(desktop, options.scopes, options.productLabel);
    client = authorized.client;
    credentials = authorized.tokens;
    if (!credentials.refresh_token) {
      throw new Error("Google OAuth did not issue an offline refresh token");
    }
    writePrivateJson(tokenPath, credentials);
  }

  client.on("tokens", (tokens) => {
    credentials = { ...credentials, ...tokens };
    writePrivateJson(tokenPath, credentials);
  });
  const access = await client.getAccessToken();
  if (!access.token) throw new Error("Google OAuth could not obtain an access token");
  const info = await client.getTokenInfo(access.token);
  const granted = [...info.scopes].sort();
  const required = [...options.scopes].sort();
  if (
    options.scopes.some((scope) => !info.scopes.includes(scope)) ||
    (options.exactScopes === true && JSON.stringify(granted) !== JSON.stringify(required))
  ) {
    throw new Error("Google OAuth did not grant the required scope set");
  }
  return client;
}

export async function loadGoogleCalendarOAuth(options: {
  clientPath: string;
  tokenPath: string;
}): Promise<GoogleOAuth2Client> {
  return loadGoogleOAuth({
    ...options,
    scopes: [GOOGLE_CALENDAR_SCOPE],
    productLabel: "the fictional filming calendar",
  });
}
