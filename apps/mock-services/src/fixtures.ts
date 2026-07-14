import { readFileSync } from "node:fs";
import type { CalendarEvent, MockSeed, Person } from "@bander/contracts";

interface CalendarFixture {
  events: CalendarEvent[];
}

interface PeopleFixture {
  people: Person[];
}

export function loadVersionedSeed(): MockSeed {
  const calendarUrl = new URL("../../../fixtures/v1/calendar.json", import.meta.url);
  const peopleUrl = new URL("../../../fixtures/v1/people.json", import.meta.url);
  const calendar = JSON.parse(readFileSync(calendarUrl, "utf8")) as CalendarFixture;
  const people = JSON.parse(readFileSync(peopleUrl, "utf8")) as PeopleFixture;

  return { events: calendar.events, people: people.people };
}
