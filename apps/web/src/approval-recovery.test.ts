import { describe, expect, it, vi } from "vitest";
import { ApiError, attemptApprovalWithRecovery } from "./App.js";

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
});
