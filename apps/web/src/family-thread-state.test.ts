import { describe, expect, it } from "vitest";
import { initialFamilyThreadState, reduceFamilyThread } from "./family-thread-state.js";

describe("R1 Family Thread state", () => {
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
    expect(reduceFamilyThread(read, { type: "prepare" })).toEqual({ stage: "preparing" });
    expect(reduceFamilyThread({ stage: "preparing" }, { type: "card_ready" })).toEqual({ stage: "card" });
    expect(reduceFamilyThread({ stage: "card" }, { type: "card_ready" })).toEqual({ stage: "card" });
  });

  it("crosses only after approval and leaves the world unchanged on decline", () => {
    expect(reduceFamilyThread({ stage: "card" }, { type: "approved" })).toEqual({ stage: "sent" });
    expect(reduceFamilyThread({ stage: "card" }, { type: "declined" })).toEqual({ stage: "declined" });
    expect(reduceFamilyThread({ stage: "declined" }, { type: "time_elapsed", milliseconds: 30_000 })).toEqual({ stage: "declined" });
  });
});
