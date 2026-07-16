import { spawn, type ChildProcess } from "node:child_process";
import { createRuntimeEnvironments } from "./process-env.js";

const baseUrl = process.env.BANDER_URL ?? "http://127.0.0.1:4310";
const ownedProcesses: ChildProcess[] = [];

async function brokerIsReady(): Promise<boolean> {
  try {
    return (await fetch(`${baseUrl}/api/status`)).ok;
  } catch {
    return false;
  }
}

async function ensureLocalServices(): Promise<void> {
  if (await brokerIsReady()) return;
  const parsedBase = new URL(baseUrl);
  const localPort = process.env.BANDER_PORT ?? "4310";
  if (
    parsedBase.protocol !== "http:" ||
    parsedBase.hostname !== "127.0.0.1" ||
    parsedBase.port !== localPort ||
    (parsedBase.pathname !== "/" && parsedBase.pathname !== "") ||
    parsedBase.search ||
    parsedBase.hash
  ) {
    throw new Error(`Bander is not reachable at configured BANDER_URL ${baseUrl}`);
  }
  const environments = createRuntimeEnvironments({
    ...process.env,
    NODE_ENV: "test",
  });
  for (const [workspace, env] of [
    ["@bander/mock-services", environments["mock-services"]],
    ["@bander/broker", environments.broker],
  ] as const) {
    ownedProcesses.push(
      spawn("npm", ["run", "start", "--workspace", workspace], {
        cwd: process.cwd(),
        env,
        stdio: "ignore",
        shell: false,
      }),
    );
  }
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await brokerIsReady()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out starting the local Bander verification services");
}

async function request<T>(
  path: string,
  init?: RequestInit,
  expectedStatus = 200,
): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body !== undefined) headers.set("content-type", "application/json");
  const response = await fetch(`${baseUrl}${path}`, { ...init, headers });
  const text = await response.text();
  if (response.status !== expectedStatus) {
    throw new Error(`${path}: expected ${expectedStatus}, received ${response.status} ${text}`);
  }
  return (text ? JSON.parse(text) : undefined) as T;
}

const post = <T>(path: string, body?: unknown, expectedStatus = 200) =>
  request<T>(
    path,
    {
      method: "POST",
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    expectedStatus,
  );

const reset = () => post<void>("/api/demo/reset", undefined, 204);

await ensureLocalServices();
try {
await reset();
const schedule = await request<{
  events: unknown[];
}>("/api/demo/schedule/tomorrow");

await reset();
const compoundCard = await post<{
  draftId: string;
  draftHash: string;
  effectPreviews: Array<{ kind: string; body?: string }>;
}>("/api/demo/proposals", { fixtureId: "move-demo-appointment-and-notify-gil" });
const compoundReceipt = await post<{ familyNotification?: { body: string } }>(
  `/api/drafts/${compoundCard.draftId}/approve`,
  { draftHash: compoundCard.draftHash },
);
const compoundState = await request<{ familyUpdates: Array<{ body: string }> }>("/api/demo/state");
await post(`/api/drafts/${compoundCard.draftId}/approve`, { draftHash: compoundCard.draftHash });
const compoundReplayState = await request<{ familyUpdates: Array<{ body: string }> }>("/api/demo/state");

await reset();
const ambiguousCard = await post<{ draftId: string; draftHash: string }>(
  "/api/demo/proposals",
  { fixtureId: "move-demo-appointment-and-notify-gil" },
);
const ambiguous = await post<{ status: string; message: string }>(
  `/api/demo/drafts/${ambiguousCard.draftId}/approve-ambiguous`,
  { draftHash: ambiguousCard.draftHash },
);
const ambiguousState = await request<{ familyUpdates: unknown[] }>("/api/demo/state");
const ambiguousReplay = await post<{ status: string; message: string }>(
  `/api/demo/drafts/${ambiguousCard.draftId}/approve-ambiguous`,
  { draftHash: ambiguousCard.draftHash },
);

await reset();
const exactCard = await post<{ draftId: string; draftHash: string }>(
  "/api/demo/proposals",
  { fixtureId: "move-dinner-and-notify-sarah" },
);
const exactReceipt = await post<{ title: string }>(
  `/api/drafts/${exactCard.draftId}/approve`,
  { draftHash: exactCard.draftHash },
);

await reset();
const conflictCard = await post<{ draftId: string; draftHash: string }>(
  "/api/demo/proposals",
  { fixtureId: "move-dinner-and-notify-sarah" },
);
const conflict = await post<{ error: { code: string } }>(
  `/api/demo/drafts/${conflictCard.draftId}/approve-after-calendar-change`,
  { draftHash: conflictCard.draftHash },
  409,
);
const agentConflict = await request<{ status: string }>(
  `/api/agent/drafts/${conflictCard.draftId}/receipt`,
);

await reset();
const candidate = await post<{ candidateId: string; predicateHash: string }>(
  "/api/demo/standing-band-candidates",
);
const standing = await post<{ bandId: string }>(
  `/api/standing-band-candidates/${candidate.candidateId}/approve`,
  { predicateHash: candidate.predicateHash },
);
const eligible = await post<{ status: string }>(
  `/api/standing-bands/${standing.bandId}/run`,
  { fixtureId: "move-my-focus-block", requestId: "verify-demo-eligible-0001" },
);
const adjacent = await post<{ status: string }>(
  `/api/standing-bands/${standing.bandId}/run`,
  { fixtureId: "move-dinner-under-standing-band", requestId: "verify-demo-adjacent-0001" },
);

await reset();
const revokeCandidate = await post<{ candidateId: string; predicateHash: string }>(
  "/api/demo/standing-band-candidates",
);
const revokeStanding = await post<{ bandId: string }>(
  `/api/standing-band-candidates/${revokeCandidate.candidateId}/approve`,
  { predicateHash: revokeCandidate.predicateHash },
);
await post<void>(`/api/bands/${revokeStanding.bandId}/revoke`, undefined, 204);
const revokedRun = await post<{ error: { code: string } }>(
  `/api/standing-bands/${revokeStanding.bandId}/run`,
  { fixtureId: "move-my-focus-block", requestId: "verify-demo-revoked-0001" },
  409,
);

console.log(
  JSON.stringify(
    {
      exact: exactReceipt.title === "Done" ? "executed" : "unexpected",
      changedWorld: conflict.error.code,
      agentConflict: agentConflict.status,
      standingEligible: eligible.status,
      standingAdjacent: adjacent.status,
      standingRevoked: revokedRun.error.code,
      scheduleRead:
        schedule.events.length > 0 ? "zero_authority_seeded_answer" : "unexpected",
      compoundFamily:
        compoundState.familyUpdates.length === 1 &&
        compoundReplayState.familyUpdates.length === 1 &&
        compoundCard.effectPreviews.find((effect) => effect.kind === "family.telegram_notification")?.body === compoundReceipt.familyNotification?.body &&
        compoundReceipt.familyNotification?.body === compoundState.familyUpdates[0]?.body
          ? "exact_text_replay_safe"
          : "unexpected",
      ambiguousCalendar:
        ambiguous.status === "calendar_outcome_ambiguous" &&
        ambiguousReplay.message === ambiguous.message &&
        !ambiguous.message.includes("nothing changed") &&
        ambiguousState.familyUpdates.length === 0
          ? "truthful_zero_family_update"
          : "unexpected",
    },
    null,
    2,
  ),
);
} finally {
  for (const child of ownedProcesses) child.kill("SIGTERM");
}
