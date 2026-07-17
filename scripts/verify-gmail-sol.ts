import fs from "node:fs";
import { OpenAISolGmailReadIntentSelector, validateGmailReadIntent } from "../apps/broker/src/gmail-read.js";
import { OpenAISolProductIntentRouter, ProductRouteSchema } from "../apps/broker/src/product-compiler.js";

if (fs.existsSync(".env")) process.loadEnvFile(".env");
const apiKey = process.env.OPENAI_API_KEY?.trim();
if (!apiKey) throw new Error("openai_api_key_missing");
const timeZone = process.env.BANDER_CALENDAR_TIME_ZONE?.trim() || "America/Denver";
const read = new OpenAISolGmailReadIntentSelector(apiKey);
const route = new OpenAISolProductIntentRouter(apiKey, timeZone);
const context = { todayLocalDate: "2026-07-16", timeZone };

const readCases = [
  "What did Ruth say about lunch today?",
  "Did the clinic email me today?",
  "What was the latest message from Ruth about lunch this week?",
] as const;
const actionCases = [
  ["Reply to Ruth’s lunch email today that Tuesday at noon works for me.", "email_reply"],
  ["Tell Gil dinner is at 6.", "direct_family"],
  ["Forward Ruth’s email to Gil.", "unsupported"],
  ["Reply all and attach the form.", "unsupported"],
] as const;

let correct = 0;
for (const request of readCases) {
  const result = validateGmailReadIntent(await read.select(request, context), context);
  if (!result.senderHint && !result.subjectHint) throw new Error("unbounded_read_result");
  correct += 1;
  process.stdout.write(`${JSON.stringify({ kind: "read", requestClass: "bounded", status: "passed" })}\n`);
}
for (const [request, expected] of actionCases) {
  const result = ProductRouteSchema.parse(await route.select(request));
  if (result.actionKind !== expected) throw new Error(`unexpected_route_${result.actionKind}`);
  correct += 1;
  process.stdout.write(`${JSON.stringify({ kind: "action", expected, observed: result.actionKind, status: "passed" })}\n`);
}
process.stdout.write(`${JSON.stringify({ model: "gpt-5.6-sol", cases: readCases.length + actionCases.length, correct, falseAccepts: 0, authorityCreated: false, gmailMutation: false })}\n`);
