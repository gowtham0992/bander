import { loadGoogleOAuth } from "./google-oauth.js";

export const GOOGLE_GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
] as const;

export function loadGoogleGmailOAuth(options: { clientPath: string; tokenPath: string }) {
  return loadGoogleOAuth({
    ...options,
    scopes: GOOGLE_GMAIL_SCOPES,
    productLabel: "the dedicated Bander Gmail test account",
    exactScopes: true,
  });
}
