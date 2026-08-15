// Time-of-day helpers for auto-close scheduling.
//
// Pure and dependency-free. workspaces.json is hand-editable and loaded with a blind
// cast, so every entry point tolerates garbage by returning null rather than letting
// a NaN reach a Date.

export interface TimeOfDay {
  hours: number;
  minutes: number;
}

const HHMM = /^(\d{2}):(\d{2})$/;

export function parseTimeOfDay(value: string | undefined | null): TimeOfDay | null {
  if (typeof value !== "string") return null;
  const match = HHMM.exec(value.trim());
  if (!match) return null;

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isInteger(hours) || hours < 0 || hours > 23) return null;
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > 59) return null;
  return { hours, minutes };
}

/** Next epoch-ms occurrence of "HH:MM" — today if still ahead, otherwise tomorrow. */
export function nextOccurrence(value: string, from: number = Date.now()): number | null {
  const tod = parseTimeOfDay(value);
  if (!tod) return null;

  const target = new Date(from);
  target.setHours(tod.hours, tod.minutes, 0, 0);
  // setDate (rather than adding 24h) keeps the wall-clock hour intact across DST.
  if (target.getTime() <= from) target.setDate(target.getDate() + 1);
  return target.getTime();
}

export function isTomorrow(fireAt: number, from: number = Date.now()): boolean {
  return new Date(fireAt).getDate() !== new Date(from).getDate();
}

/** "15:00" -> "3:00 PM", following the user's locale. Empty string if malformed. */
export function formatTimeOfDay(value: string | undefined | null): string {
  const tod = parseTimeOfDay(value);
  if (!tod) return "";
  const d = new Date();
  d.setHours(tod.hours, tod.minutes, 0, 0);
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

export function hhmmFromDate(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** now + `hours`, rounded to the nearest 5 minutes. Presets shouldn't imply precision. */
export function offsetPreset(hours: number, from: number = Date.now()): string {
  const d = new Date(from + hours * 3_600_000);
  d.setMinutes(Math.round(d.getMinutes() / 5) * 5, 0, 0);
  return hhmmFromDate(d);
}
