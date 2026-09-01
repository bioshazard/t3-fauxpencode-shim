// T3's project event stream is the best available signal for a cwd-less
// session-create request. Real OpenCode never needs this because it runs
// inside the project; this tracker remembers recent event-stream sightings so
// session creation can fall back to the active project instead of PI_CWD.

const DEFAULT_WINDOW_MS = 30_000;

type Sighting = { readonly at: number };

export class ActiveDirectoryTracker {
  private readonly windowMs: number;
  private readonly sightings = new Map<string, Sighting>();

  constructor(windowMs: number = DEFAULT_WINDOW_MS) {
    this.windowMs = windowMs;
  }

  record(directory: string, now = Date.now()): void {
    this.prune(now);
    this.sightings.set(directory, { at: now });
  }

  current(now = Date.now()): string | null {
    this.prune(now);
    let best: Sighting | null = null;
    let directory: string | null = null;
    for (const [candidate, sighting] of this.sightings) {
      if (best === null || sighting.at > best.at) {
        best = sighting;
        directory = candidate;
      }
    }
    return directory;
  }

  private prune(now: number): void {
    for (const [directory, sighting] of this.sightings) {
      if (now - sighting.at > this.windowMs) this.sightings.delete(directory);
    }
  }
}
