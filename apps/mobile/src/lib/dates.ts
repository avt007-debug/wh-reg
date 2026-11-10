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
