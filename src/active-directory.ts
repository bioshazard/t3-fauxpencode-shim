// T3 includes its selected project in health and event requests before a
// cwd-less session-create request. This tracker keeps the latest signal.

const DEFAULT_WINDOW_MS = 30_000;

type Sighting = { readonly at: number; readonly sequence: number };

export class ActiveDirectoryTracker {
  private readonly windowMs: number;
  private readonly sightings = new Map<string, Sighting>();
  private sequence = 0;

  constructor(windowMs: number = DEFAULT_WINDOW_MS) {
    this.windowMs = windowMs;
  }

  record(directory: string, now = Date.now()): void {
    this.prune(now);
    this.sightings.set(directory, { at: now, sequence: this.sequence++ });
  }

  current(now = Date.now()): string | null {
    this.prune(now);
    let best: Sighting | null = null;
    let directory: string | null = null;
    for (const [candidate, sighting] of this.sightings) {
      if (
        best === null ||
        sighting.at > best.at ||
        (sighting.at === best.at && sighting.sequence > best.sequence)
      ) {
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
