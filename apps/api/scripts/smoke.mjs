// End-to-end smoke test against a running API + seeded dev DB.
// Usage: API_URL=http://localhost:4000 node apps/api/scripts/smoke.mjs
import { randomUUID } from 'node:crypto';

const API = (process.env.API_URL ?? 'http://localhost:4000') + '/v1';
let failures = 0;
const check = (cond, name, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${name}`);
  if (!cond) { failures++; if (extra !== undefined) console.log('      ', JSON.stringify(extra).slice(0, 400)); }
};
async function call(method, path, token, body) {
  const res = await fetch(API + path, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
const login = async (loginId) => (await call('POST', '/auth/login', null, { loginId, password: 'ChangeMe@123' })).body;

// ---------------- employee
const bad = await call('POST', '/auth/login', null, { loginId: 'ravi.wha', password: 'wrong-password' });
check(bad.status === 401, 'wrong password → 401');
const emp = await login('ravi.wha');
check(!!emp?.accessToken && emp.user.role === 'EMPLOYEE', 'employee login issues tokens');
const T = emp.accessToken;

const me = await call('GET', '/me', T);
check(me.body?.warehouse_code === 'WHA', 'employee is tied to WHA', me.body);

const search = await call('GET', '/products/search?q=pana', T);
check(search.body?.[0]?.sku_code === 'STN-CS-1724', 'vernacular alias search "pana" → spanner set', search.body);
const drill = (await call('GET', '/products/search?q=drill%20machin', T)).body[0];
const plug = (await call('GET', '/products/search?q=gitti', T)).body[0];
check(drill?.sku_code === 'BOS-GSB13RE' && plug?.uoms?.[0]?.code === 'CTN', 'typo search + UoM list');

const inv = await call('GET', '/inventory', T);
check(inv.body.length === 4 && !('valuation' in inv.body[0]) && !('avg_effective_cost_base' in inv.body[0]),
  'inventory: own warehouse, no cost/value fields');

const ownerAsEmp = await call('GET', '/owner/stock-overview', T);
check(ownerAsEmp.status === 403, 'employee blocked from owner dashboard');

const customers = (await call('GET', '/customers?q=Sri', T)).body;
const line = { productId: drill.id, uomCode: 'PCS', qty: 40, unitBasePrice: 3200, discountPct: 5 };
const dispatchBody = { clientTxnId: randomUUID(), customerId: customers[0].id, transportMode: 'TRANSPORTER',
  transporterName: 'VRL Logistics', vehicleRegNo: 'KA 01 AB 1234', driverPhone: '+91 98450 12345', lines: [line] };

const blocked = await call('POST', '/dispatches', T, dispatchBody);
check(blocked.status === 409 && blocked.body.code === 'INSUFFICIENT_STOCK' && blocked.body.details[0].availableBase === 25,
  'dispatch of 40 with 25 in stock → 409 with shortfall details', blocked.body);

const wrongPin = await call('POST', '/overrides', T, { pin: '000000', reason: 'test' });
check(wrongPin.status === 403 && wrongPin.body.code === 'INVALID_PIN', 'wrong override PIN → 403');
const ovr = await call('POST', '/overrides', T, { pin: '246810', reason: 'Dealer urgent; stock arriving tomorrow' });
check(!!ovr.body?.overrideId, 'correct PIN → overrideId');

const ok = await call('POST', '/dispatches', T, { ...dispatchBody, overrideId: ovr.body.overrideId });
check(ok.status === 201 && ok.body.dispatch.grand_total === 143488 && ok.body.dispatch.used_override,
  'dispatch with override → 201; 40 × 3,200 less 5% + 18% GST = ₹1,43,488', ok.body);
const replay = await call('POST', '/dispatches', T, { ...dispatchBody, overrideId: ovr.body.overrideId });
check(replay.status === 200 && replay.body.replayed && replay.body.dispatch.id === ok.body.dispatch.id, 'idempotent retry returns same invoice');

const vendors = (await call('GET', '/vendors?q=Karnataka', T)).body;
const pur = await call('POST', '/purchases', T, {
  clientTxnId: randomUUID(), vendorId: vendors[0].id, vendorInvoiceNo: 'KTD-' + Date.now(), vendorInvoiceDate: new Date().toISOString().slice(0, 10),
  lines: [{ productId: drill.id, uomCode: 'PCS', qty: 50, gstRate: 18, unitBasePrice: 2711.8644, unitInclPrice: 3200 }],
});
check(pur.status === 201 && pur.body.purchase.grand_total === 160000 && pur.body.purchase.cgst_total === 12203.39,
  'inward from inclusive price: totals + CGST/SGST', pur.body);

const log = await call('GET', '/dispatches', T);
check(log.body.length === 1, "employee's daily log shows own invoice");

// ---------------- owner
const own = await login('owner');
const O = own.accessToken;
const today = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
const range = `from=${today.slice(0, 8)}01&to=${today}`;
const so = await call('GET', '/owner/stock-overview', O);
check(so.status === 200 && so.body.warehouses.length === 2 && so.body.items.length >= 4, 'owner: multi-warehouse stock overview + valuation');
const ra = await call('GET', '/owner/reorder-alerts', O);
check(ra.status === 200 && ra.body.length > 0, 'owner: reorder alerts');
const trend = await call('GET', `/owner/sales/trend?${range}&granularity=month`, O);
check(trend.status === 200 && trend.body[0]?.warehouse_code === 'WHA', 'owner: monthly sales trend by warehouse', trend.body);
const top = await call('GET', `/owner/top-items?${range}`, O);
check(top.status === 200 && top.body[0]?.sku_code === 'BOS-GSB13RE', 'owner: top selling items');
const margins = await call('GET', `/owner/margins?${range}`, O);
check(margins.status === 200 && margins.body.length >= 1, 'owner: margin spread by category');
const dead = await call('GET', '/owner/dead-stock?days=45', O);
check(dead.status === 200, 'owner: dead stock (45 days)');
const perf = await call('GET', `/owner/staff-performance?${range}`, O);
check(perf.status === 200 && perf.body.staff[0]?.full_name === 'Ravi (WHA)', 'owner: staff performance');
const disc = await call('PUT', `/owner/purchases/${pur.body.purchase.id}/discount`, O, { discountType: 'PERCENT', discountValue: 3, reason: 'Cash discount' });
check(disc.status === 200 && disc.body.net_payable === 160000 - 4067.8, 'owner: private purchase discount → net payable', disc.body);
const empPurchases = await call('GET', '/purchases', T);
check(!JSON.stringify(empPurchases.body).includes('net_payable') && !JSON.stringify(empPurchases.body).includes('owner_discount'),
  'employee purchase view never includes the owner discount');

console.log(failures ? `\n✗ ${failures} smoke check(s) failed` : '\n✓ ALL SMOKE CHECKS PASSED');
process.exit(failures ? 1 : 0);
