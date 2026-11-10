import { todayIST } from './ids';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "Nov 26" for 2026-11-01 */
export const monthLabel = (iso: string) => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(2, 4)}`;
/** "November 2026" */
export const monthLong = (iso: string) => `${MONTHS_LONG[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;
/** "10-11-2026" */
export const dmy = (iso: string | null | undefined) => (iso ? `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}` : '');

/** First day of the month `back` months before the current IST month (negative = ahead), yyyy-mm-01. */
export function monthStart(back = 0, from = todayIST()) {
  const [y, m] = from.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1 - back, 1)).toISOString().slice(0, 10);
}

/** "09:12 AM" in IST for a timestamp */
export const timeIST = (ts: string | null | undefined) => {
  if (!ts) return '—';
  const d = new Date(new Date(ts).getTime() + 5.5 * 3600_000);
  const h = d.getUTCHours(), m = d.getUTCMinutes();
  return `${String(((h + 11) % 12) + 1).padStart(2, '0')}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
};
/** "10-11-2026 09:12 AM" in IST */
export const dateTimeIST = (ts: string | null | undefined) => {
  if (!ts) return '—';
  const d = new Date(new Date(ts).getTime() + 5.5 * 3600_000).toISOString().slice(0, 10);
  return `${dmy(d)} ${timeIST(ts)}`;
};
/** "3h 25m" */
export const hoursLabel = (h: number | null | undefined) => {
  if (h == null) return '—';
  const mins = Math.round(Number(h) * 60);
  return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`;
};
