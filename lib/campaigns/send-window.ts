// §5.2 and §8.2: each recipient's send window applies in that zone's local time, including clock changes.
// Start is inclusive and end is exclusive (G-11). Pure, and shared by both channels.

export type SendWindow = { start: string; end: string; tz?: string };

export type SendWindowState = {
  /** Zones whose recipients can be claimed now. */
  openZones: string[];
  /** When none is open, the earliest time one will be. Null when something is open, or there are no zones. */
  waitUntil: Date | null;
};

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

const minutesOf = (time: string) => {
  const [h, m] = time.split(':').map(Number);
  return h! * 60 + m!;
};

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(zone: string) {
  let f = formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    formatters.set(zone, f);
  }
  return f;
}

/** The wall clock in a zone, written as if it were UTC, so plain date arithmetic works on it. */
function wallClock(instant: Date, zone: string): number {
  const parts = Object.fromEntries(formatter(zone).formatToParts(instant).map((p) => [p.type, Number(p.value)]));
  return Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!);
}

/** The instant a wall-clock time happens in a zone. A time skipped by a clock change moves forward by the size of the change. */
function fromWallClock(wall: number, zone: string): Date {
  const guess = wall - (wallClock(new Date(wall), zone) - wall);
  const offset = wallClock(new Date(guess), zone) - guess;
  const instant = new Date(wall - offset);
  if (wallClock(instant, zone) === wall) return instant;
  return new Date(guess);
}

function isOpen(minutes: number, start: number, end: number) {
  return start <= end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

/** The first moment at or after `from` that the zone's window is open. */
function nextOpen(from: Date, zone: string, window: SendWindow): Date {
  const start = minutesOf(window.start);
  const end = minutesOf(window.end);
  const wall = wallClock(from, zone);
  const minutes = Math.floor((wall % DAY) / MINUTE);
  if (isOpen(minutes, start, end)) return from;
  const midnight = wall - (wall % DAY);
  const startToday = midnight + start * MINUTE;
  return fromWallClock(minutes < start ? startToday : startToday + DAY, zone);
}

export function sendWindowState({ now, zones, window, scheduledAt }: { now: Date; zones: string[]; window: SendWindow; scheduledAt?: Date | null }): SendWindowState {
  if (zones.length === 0) return { openZones: [], waitUntil: null };
  const from = scheduledAt && scheduledAt > now ? scheduledAt : now;
  const opens = zones.map((zone) => ({ zone, at: nextOpen(from, zone, window) }));
  const openZones = opens.filter((o) => o.at.getTime() <= now.getTime()).map((o) => o.zone);
  if (openZones.length > 0) return { openZones, waitUntil: null };
  return { openZones: [], waitUntil: new Date(Math.min(...opens.map((o) => o.at.getTime()))) };
}
