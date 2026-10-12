// Philippine time (Asia/Manila, UTC+8, no daylight saving).
// Everything in the app that shows "today", a clock time, or the current year goes through here,
// so it looks the same whatever time zone a phone or computer happens to be set to.
// Dates without a time of day (an event date, a leave date) are plain calendar dates and are not converted.

export const PH_TZ = "Asia/Manila";

const dateParts = new Intl.DateTimeFormat("en-US", { timeZone: PH_TZ, year: "numeric", month: "2-digit", day: "2-digit" });

/** Today's date in the Philippines as YYYY-MM-DD. */
export function todayPH(d = new Date()) {
  const p = Object.fromEntries(dateParts.formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

/** The current year in the Philippines. */
export function yearPH(d = new Date()) {
  return Number(todayPH(d).slice(0, 4));
}

/** A YYYY-MM-DD date moved by n days (n can be negative). */
export function addDaysISO(isoDate, n) {
  const [y, m, d] = isoDate.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** A moment (ISO timestamp) as a clock time in the Philippines, e.g. "8:05 AM". */
export function timePH(value, options = { hour: "numeric", minute: "2-digit" }) {
  if (!value) return "";
  return new Date(value).toLocaleTimeString(undefined, { ...options, timeZone: PH_TZ });
}

/** A moment (ISO timestamp) as date and time in the Philippines. */
export function dateTimePH(value, options = { dateStyle: "medium", timeStyle: "short" }) {
  if (!value) return "";
  return new Date(value).toLocaleString(undefined, { ...options, timeZone: PH_TZ });
}

/** "HH:MM" on a YYYY-MM-DD date, read as Philippine time, as an exact moment. */
export function momentPH(isoDate, hhmm) {
  return new Date(`${isoDate}T${hhmm}:00+08:00`);
}
