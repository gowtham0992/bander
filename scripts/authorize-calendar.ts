import fs from "node:fs";
import { GOOGLE_CALENDAR_SCOPE, loadGoogleOAuth } from "../apps/broker/src/google-oauth.js";
if (fs.existsSync(".env")) process.loadEnvFile(".env");
try {
  const clientPath = process.env.GOOGLE_OAUTH_CLIENT_PATH?.trim();
  const tokenPath = process.env.GOOGLE_OAUTH_TOKEN_PATH?.trim();
  if (!clientPath || !tokenPath) throw new Error();
  await loadGoogleOAuth({ clientPath, tokenPath, scopes: [GOOGLE_CALENDAR_SCOPE], productLabel: "Google Calendar", exactScopes: true });
  process.stdout.write("Calendar OAuth is ready with only the required owned-events scope.\n");
} catch {
  process.stderr.write("Calendar OAuth could not be completed. Check the Desktop client, configured test account, token path, and consent, then try again.\n");
  process.exitCode = 1;
}
