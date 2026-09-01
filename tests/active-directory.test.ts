import { describe, expect, test } from "bun:test";

import { ActiveDirectoryTracker } from "../src/active-directory.ts";

describe("active directory tracker", () => {
  test("has no active directory until one is recorded", () => {
    const tracker = new ActiveDirectoryTracker();

    expect(tracker.current(1_000)).toBeNull();
  });

  test("returns the most recently recorded directory", () => {
    const tracker = new ActiveDirectoryTracker();
    tracker.record("/proj/old", 1_000);
    tracker.record("/proj/new", 2_000);

    expect(tracker.current(2_500)).toBe("/proj/new");
  });

  test("refreshes a repeated directory instead of stacking it", () => {
    const tracker = new ActiveDirectoryTracker(1_000);
    tracker.record("/proj/a", 0);
    tracker.record("/proj/b", 500);
    tracker.record("/proj/a", 900);

    expect(tracker.current(1_400)).toBe("/proj/a");
    expect(tracker.current(2_000)).toBeNull();
  });

  test("expires sightings once the recency window passes", () => {
    const tracker = new ActiveDirectoryTracker(1_000);
    tracker.record("/proj/a", 0);

    expect(tracker.current(1_000)).toBe("/proj/a");
    expect(tracker.current(1_001)).toBeNull();
  });

  test("prunes expired sightings", () => {
    const tracker = new ActiveDirectoryTracker(1_000);
    tracker.record("/proj/expired", 0);
    tracker.record("/proj/current", 2_000);

    expect(tracker.current(2_000)).toBe("/proj/current");
  });
});
