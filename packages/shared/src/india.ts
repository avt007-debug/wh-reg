/** India-specific identifiers: GSTIN, state codes, vehicle numbers, mobile numbers. */

const CS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

/** Structural + mod-36 checksum validation (same algorithm as app.gstin_valid in SQL). */
export function isValidGstin(raw: string): boolean {
  const g = raw.trim().toUpperCase();
  if (!GSTIN_RE.test(g)) return false;
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const p = CS.indexOf(g[i]!) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(p / 36) + (p % 36);
  }
  return CS[(36 - (sum % 36)) % 36] === g[14];
}

export const gstinStateCode = (g: string) => g.trim().slice(0, 2);

export const STATE_CODES: Record<string, string> = {
  '01': 'Jammu & Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh',
  '05': 'Uttarakhand', '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh',
  '10': 'Bihar', '11': 'Sikkim', '12': 'Arunachal Pradesh', '13': 'Nagaland', '14': 'Manipur',
  '15': 'Mizoram', '16': 'Tripura', '17': 'Meghalaya', '18': 'Assam', '19': 'West Bengal',
  '20': 'Jharkhand', '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh', '24': 'Gujarat',
  '26': 'Dadra & Nagar Haveli and Daman & Diu', '27': 'Maharashtra', '29': 'Karnataka', '30': 'Goa',
  '31': 'Lakshadweep', '32': 'Kerala', '33': 'Tamil Nadu', '34': 'Puducherry',
  '35': 'Andaman & Nicobar Islands', '36': 'Telangana', '37': 'Andhra Pradesh', '38': 'Ladakh',
  '97': 'Other Territory',
};

/** 'ka-01 ab 1234' → 'KA01AB1234' */
export const normalizeVehicleNo = (v: string) => v.toUpperCase().replace(/[^A-Z0-9]/g, '');

/** Standard (KA01AB1234) and Bharat-series (22BH1234AB) registrations. */
export const isValidVehicleNo = (v: string) =>
  /^([A-Z]{2}[0-9]{1,2}[A-Z]{0,3}[0-9]{4}|[0-9]{2}BH[0-9]{4}[A-Z]{1,2})$/.test(normalizeVehicleNo(v));

/** '+91 98450-12345' → '9845012345' */
export const normalizeMobile = (p: string) => p.replace(/\D/g, '').slice(-10);
export const isValidMobile = (p: string) => /^[6-9][0-9]{9}$/.test(normalizeMobile(p));
