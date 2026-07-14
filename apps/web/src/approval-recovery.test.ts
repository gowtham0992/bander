import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { HumanReceipt } from "@bander/contracts";
import {
  ApiError,
  StandingRecoveryView,
  attemptApprovalWithRecovery,
  attemptStandingRunWithRecovery,
  type StandingRunInput,
} from "./App.js";

describe("browser approval recovery", () => {
  it("automatically retries once after an ambiguous failure", async () => {
    const attempt = vi
      .fn<() => Promise<{ receiptId: string }>>()
      .mockRejectedValueOnce(new Error("response lost"))
      .mockResolvedValueOnce({ receiptId: "receipt-one" });
    const onRecoveryAttempt = vi.fn();

    await expect(
      attemptApprovalWithRecovery(attempt, onRecoveryAttempt),
    ).resolves.toEqual({
      status: "confirmed",
      value: { receiptId: "receipt-one" },
    });
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(onRecoveryAttempt).toHaveBeenCalledOnce();
  });

  it("does not retry an explicit conflict", async () => {
    const conflict = new ApiError("The world changed", 409, "conflict");
    const attempt = vi.fn<() => Promise<never>>().mockRejectedValue(conflict);

    await expect(
      attemptApprovalWithRecovery(attempt, vi.fn()),
    ).rejects.toBe(conflict);
    expect(attempt).toHaveBeenCalledOnce();
  });

  it("offers manual recovery after two ambiguous failures", async () => {
    const attempt = vi.fn<() => Promise<never>>().mockRejectedValue(
      new ApiError("Bander could not confirm the result", 500, "internal_error"),
    );

    await expect(
      attemptApprovalWithRecovery(attempt, vi.fn()),
    ).resolves.toEqual({ status: "ambiguous" });
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it("reuses one standing request ID through automatic and manual recovery", async () => {
    const input: StandingRunInput = {
      bandId: "band-standing-0001",
      fixtureId: "move-my-focus-block",
      requestId: "browser-standing-request-0001",
      expected: "executed",
    };
    const observedRequestIds: string[] = [];
    const receipt: HumanReceipt = {
      id: "receipt-standing-browser",
      draftId: "draft-standing-browser",
      title: "Done",
      summary: "Completed as agreed.",
      detail: "No messages were sent.",
      calendar: {
        title: "Focus block",
        previous: {
          startTime: "2026-07-15T10:00:00-06:00",
          endTime: "2026-07-15T11:00:00-06:00",
        },
        completed: {
          startTime: "2026-07-15T10:30:00-06:00",
          endTime: "2026-07-15T11:30:00-06:00",
        },
        timeZone: "America/Denver",
      },
      completedAt: "2026-07-14T18:00:00.000Z",
    };
    const request = vi.fn(async (received: StandingRunInput) => {
      observedRequestIds.push(received.requestId);
      if (observedRequestIds.length <= 2) throw new Error("ambiguous response");
      return { status: "executed" as const, receipt };
    });

    await expect(
      attemptStandingRunWithRecovery(input, request, vi.fn()),
    ).resolves.toEqual({ status: "ambiguous" });
    await expect(
      attemptStandingRunWithRecovery(input, request, vi.fn()),
    ).resolves.toMatchObject({
      status: "confirmed",
      value: { status: "executed", receipt: { id: "receipt-standing-browser" } },
    });
    expect(observedRequestIds).toEqual([
      input.requestId,
      input.requestId,
      input.requestId,
    ]);
  });

  it("never claims non-action for an ambiguous standing result", () => {
    const markup = renderToStaticMarkup(
      createElement(StandingRecoveryView, {
        busy: false,
        message: "Bander couldn’t confirm the result yet.",
        onCheck: vi.fn(),
        onBack: vi.fn(),
      }),
    );

    expect(markup).toContain("Check what happened");
    expect(markup).not.toContain("Bander didn’t act");
  });
});
