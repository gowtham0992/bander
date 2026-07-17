import fs from "node:fs";
import path from "node:path";
import { loadGoogleGmailOAuth } from "../apps/broker/src/google-gmail-oauth.js";

if (fs.existsSync(".env")) process.loadEnvFile(".env");

const clientPath = process.env.GMAIL_OAUTH_CLIENT_PATH?.trim();
const tokenPath = process.env.GMAIL_OAUTH_TOKEN_PATH?.trim();
const calendarTokenPath = process.env.GOOGLE_OAUTH_TOKEN_PATH?.trim();

if (!clientPath || !tokenPath || (calendarTokenPath && path.resolve(tokenPath) === path.resolve(calendarTokenPath))) {
  process.stderr.write(
    "Set GMAIL_OAUTH_CLIENT_PATH and GMAIL_OAUTH_TOKEN_PATH in .env. The Gmail token path must be separate from the Calendar token path.\n",
  );
  process.exitCode = 1;
} else {
  try {
    await loadGoogleGmailOAuth({ clientPath, tokenPath });
    process.stdout.write(
      "Gmail OAuth is ready with only the required read and send scopes.\n",
    );
  } catch {
    process.stderr.write(
      "Gmail OAuth could not be completed. Check the Desktop client, test-user access, token path, and consent, then try again.\n",
    );
    process.exitCode = 1;
  }
}
