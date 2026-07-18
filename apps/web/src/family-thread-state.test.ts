import { describe, expect, it } from "vitest";
import { initialFamilyThreadState, reduceFamilyThread } from "./family-thread-state.js";

describe("Family Thread state", () => {
  it("starts idle and cannot advance without a visitor action", () => {
    expect(initialFamilyThreadState).toEqual({ stage: "idle" });
    expect(reduceFamilyThread(initialFamilyThreadState, { type: "time_elapsed", milliseconds: 30_000 })).toEqual(initialFamilyThreadState);
  });

  it("keeps a harmless read on the conversation side of the Line", () => {
    const asking = reduceFamilyThread(initialFamilyThreadState, { type: "ask" });
    const read = reduceFamilyThread(asking, { type: "read_completed" });
    expect(read).toEqual({ stage: "read" });
    expect(read.stage).not.toBe("card");
    expect(read.stage).not.toBe("sent");
  });

  it("forms exactly one deal only after the second visitor action", () => {
    const read = { stage: "read" } as const;
    expect(reduceFamilyThread(read, { type: "prepare_email" })).toEqual({ stage: "email_preparing" });
    expect(reduceFamilyThread({ stage: "email_preparing" }, { type: "email_card_ready" })).toEqual({ stage: "email_waiting" });
    expect(reduceFamilyThread({ stage: "email_waiting" }, { type: "email_card_ready" })).toEqual({ stage: "email_waiting" });
  });

  it("crosses only after approval and leaves the world unchanged on decline", () => {
    expect(reduceFamilyThread({ stage: "email_waiting" }, { type: "email_approved" })).toEqual({ stage: "email_confirmed" });
    expect(reduceFamilyThread({ stage: "email_waiting" }, { type: "email_declined" })).toEqual({ stage: "email_declined" });
    expect(reduceFamilyThread({ stage: "email_declined" }, { type: "time_elapsed", milliseconds: 30_000 })).toEqual({ stage: "email_declined" });
  });
});
