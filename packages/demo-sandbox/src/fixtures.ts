import draftsJson from "../../../fixtures/v1/drafts.json" with { type: "json" };
import calendarJson from "../../../fixtures/v1/calendar.json" with { type: "json" };
import peopleJson from "../../../fixtures/v1/people.json" with { type: "json" };
import type { DraftFixture } from "@bander/core";
import type { CalendarEvent, Person } from "@bander/contracts";

const emailFixture: DraftFixture = {
  id: "reply-to-ruth-about-lunch",
  claimedUserRequest: "Reply to Ruth’s lunch email: Tuesday at noon works for me.",
  emailReply: {
    type: "email.reply",
    sourceMessageId: "sandbox-message-ruth-lunch",
    threadId: "sandbox-thread-ruth-lunch",
    latestThreadMessageId: "sandbox-message-ruth-lunch",
    recipient: "ruth@example.test",
    subject: "Re: Lunch next week",
    inReplyTo: "<sandbox-ruth-lunch@example.test>",
    references: ["<sandbox-ruth-lunch@example.test>"],
    body: "Tuesday at noon works for me.",
    rfcMessageId: "<bander-sandbox-reply@example.invalid>",
    reconciliationToken: "f0839f07c329a83f699b78cf3611189092ce3848cf3b19f9a374bbf1d594613e",
    rawMimeBase64Url: "VG86IHJ1dGhAZXhhbXBsZS50ZXN0DQpTdWJqZWN0OiBSZTogTHVuY2ggbmV4dCB3ZWVrDQpNZXNzYWdlLUlEOiA8YmFuZGVyLXNhbmRib3gtcmVwbHlAZXhhbXBsZS5pbnZhbGlkPg0KWC1CYW5kZXItT3BlcmF0aW9uOiBmMDgzOWYwN2MzMjlhODNmNjk5Yjc4Y2YzNjExMTg5MDkyY2UzODQ4Y2YzYjE5ZjlhMzc0YmJmMWQ1OTQ2MTNlDQpJbi1SZXBseS1UbzogPHNhbmRib3gtcnV0aC1sdW5jaEBleGFtcGxlLnRlc3Q-DQpSZWZlcmVuY2VzOiA8c2FuZGJveC1ydXRoLWx1bmNoQGV4YW1wbGUudGVzdD4NCk1JTUUtVmVyc2lvbjogMS4wDQpDb250ZW50LVR5cGU6IHRleHQvcGxhaW47IGNoYXJzZXQ9VVRGLTgNCkNvbnRlbnQtVHJhbnNmZXItRW5jb2Rpbmc6IDhiaXQNCg0KVHVlc2RheSBhdCBub29uIHdvcmtzIGZvciBtZS4NCg",
    mimeDigest: "20f9dd376b1473b121c2f86ac16a6e878cde88a0d73e48b4418873f5f7b6e862",
  },
};

const directFamilyFixture: DraftFixture = {
  id: "tell-gil-dinner-is-at-six",
  claimedUserRequest: "Tell Gil dinner is at 6.",
  familyNotification: {
    installationId: "sandbox-installation",
    contactId: "sandbox-contact-gil",
    pairingRevision: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    displayLabel: "Gil",
    document: { kind: "direct_message", body: "Dinner is at 6." },
  },
};

const guidedEmailFixture: DraftFixture = {
  id: "reply-to-dr-rao-about-thursday",
  claimedUserRequest: "Reply that Thursday at 2 works.",
  emailReply: {
    type: "email.reply",
    sourceMessageId: "sandbox-message-dr-rao",
    threadId: "sandbox-thread-dr-rao",
    latestThreadMessageId: "sandbox-message-dr-rao",
    recipient: "office@example.test",
    subject: "Re: Appointment options",
    inReplyTo: "<sandbox-dr-rao@example.test>",
    references: ["<sandbox-dr-rao@example.test>"],
    body: "Thursday at 2 works.",
    rfcMessageId: "<bander-sandbox-dr-rao-reply@example.invalid>",
    reconciliationToken: "153e49e99444c5ce27723fe407d59d79edf2a6790f2f95992ee788f851e9abc1",
    rawMimeBase64Url: "VG86IG9mZmljZUBleGFtcGxlLnRlc3QNClN1YmplY3Q6IFJlOiBBcHBvaW50bWVudCBvcHRpb25zDQpNZXNzYWdlLUlEOiA8YmFuZGVyLXNhbmRib3gtZHItcmFvLXJlcGx5QGV4YW1wbGUuaW52YWxpZD4NClgtQmFuZGVyLU9wZXJhdGlvbjogMTUzZTQ5ZTk5NDQ0YzVjZTI3NzIzZmU0MDdkNTlkNzllZGYyYTY3OTBmMmY5NTk5MmVlNzg4Zjg1MWU5YWJjMQ0KSW4tUmVwbHktVG86IDxzYW5kYm94LWRyLXJhb0BleGFtcGxlLnRlc3Q-DQpSZWZlcmVuY2VzOiA8c2FuZGJveC1kci1yYW9AZXhhbXBsZS50ZXN0Pg0KTUlNRS1WZXJzaW9uOiAxLjANCkNvbnRlbnQtVHlwZTogdGV4dC9wbGFpbjsgY2hhcnNldD1VVEYtOA0KQ29udGVudC1UcmFuc2Zlci1FbmNvZGluZzogOGJpdA0KDQpUaHVyc2RheSBhdCAyIHdvcmtzLg0K",
    mimeDigest: "273d87dc92183500c9cd78853d80955cd964db58bd24fb731b5645e3fe0cfe07",
  },
};

const guidedCalendarFixture: DraftFixture = {
  id: "add-dr-rao-appointment-and-notify-gil",
  claimedUserRequest: "Add Dr. Rao’s appointment Thursday at 2 PM and let Gil know.",
  calendar: {
    kind: "create",
    eventId: "d0c70ab1e5aa9",
    title: "Appointment with Dr. Rao",
    startTime: "2026-07-23T20:00:00.000Z",
    endTime: "2026-07-23T21:00:00.000Z",
    timeZone: "America/Denver",
  },
  familyNotification: {
    installationId: "sandbox-installation",
    contactId: "sandbox-contact-gil",
    pairingRevision: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    displayLabel: "Gil",
    document: {
      kind: "calendar_creation",
      eventTitle: "Appointment with Dr. Rao",
      startTime: "2026-07-23T20:00:00.000Z",
      endTime: "2026-07-23T21:00:00.000Z",
      timeZone: "America/Denver",
    },
  },
};

export function versionedDraftFixtures(): Map<string, DraftFixture> {
  const fixtures = (draftsJson.fixtures as DraftFixture[]).map((fixture) => structuredClone(fixture));
  return new Map([...fixtures, emailFixture, directFamilyFixture, guidedEmailFixture, guidedCalendarFixture].map((fixture) => [fixture.id, structuredClone(fixture)]));
}

export function versionedCalendarEvents(): CalendarEvent[] {
  return structuredClone(calendarJson.events) as CalendarEvent[];
}

export function versionedPeople(): Person[] {
  return structuredClone(peopleJson.people) as Person[];
}
