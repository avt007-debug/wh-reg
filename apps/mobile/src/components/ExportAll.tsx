/** One Excel file with everything for a period: sales, items sold, purchases, payments in / out, expenses, customers, suppliers, stock, attendance. */
import { useState } from 'react';
import { View } from 'react-native';
import { rpc } from '../api/client';
import { dmy } from '../lib/dates';
import { notify } from '../lib/dialogs';
import { exportXlsx } from '../lib/exportFile';
import { todayIST } from '../lib/ids';
import { fileStamp } from '../lib/warehouse';
import type { Column } from '../lib/xlsx';
import { Button, Card, Field } from './ui';

type Row = Record<string, unknown>;
const toIso = (d: string) => { const m = d.trim().match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/); return m ? `${m[3]}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}` : null; };
const MONEY = /^(taxable|cgst|sgst|igst|charges|total|amount|price|discount|gst|billed|paid|balance|overdue|value|purchased|debit_notes|credits_used|outstanding)$/;
const DATE = /^(date|last_bill_date|last_payment_date|last_purchase|last_payment)$/;
const title = (k: string) => k.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

function sheet(name: string, rows: Row[], keys?: string[]) {
  const cols = keys ?? Object.keys(rows[0] ?? {}).filter((k) => typeof rows[0]![k] !== 'object' || rows[0]![k] === null);
  return {
    name, columns: cols.map<Column>((k) => ({ header: title(k), kind: MONEY.test(k) ? 'money' : DATE.test(k) ? 'date' : typeof rows[0]?.[k] === 'number' ? 'number' : 'text', width: Math.max(10, Math.min(30, k.length + 6)) })),
    rows: rows.map((r) => cols.map((k) => { const v = r[k]; return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v) ? v.slice(0, 16).replace('T', ' ') : (v as string | number | null); })),
  };
}

export function ExportAll() {
  const [from, setFrom] = useState(dmy(`${todayIST().slice(0, 4)}-${Number(todayIST().slice(5, 7)) >= 4 ? '04' : '04'}-01`));
  const [to, setTo] = useState(dmy(todayIST()));
  const [busy, setBusy] = useState(false);
  const go = async () => {
    const f = toIso(from); const t = toIso(to);
    if (!f || !t) return;
    setBusy(true);
    try {
      const d = await rpc<Record<string, Row[]>>('owner_export_all', { p_from: f, p_to: t });
      await exportXlsx(`WHReg_everything_${f}_to_${t}_${fileStamp()}`, [
        sheet('Sales', d.sales ?? []), sheet('Items sold', d.sale_items ?? []), sheet('Purchases', d.purchases ?? []),
        sheet('Payments received', d.payments_in ?? []), sheet('Supplier payments', d.payments_out ?? []), sheet('Expenses', d.expenses ?? []),
        sheet('Customers', d.customers ?? [], ['name', 'gstin', 'phone', 'address', 'credit_limit', 'credit_days', 'bills', 'billed', 'paid', 'balance', 'overdue', 'last_bill_date', 'last_payment_date']),
        sheet('Suppliers', d.suppliers ?? [], ['name', 'gstin', 'phone', 'default_discount_pct', 'credit_days', 'purchases', 'purchased', 'paid', 'debit_notes', 'credits_used', 'balance', 'overdue', 'last_purchase', 'last_payment']),
        sheet('Stock now', d.stock ?? []), sheet('Attendance', d.attendance ?? []),
      ].filter((s) => s.rows.length));
    } catch (e) { notify('Export failed', e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  return (
    <Card title="Export everything to Excel" icon="download-outline" subtitle="One file with a sheet each for sales, items sold, purchases, payments, expenses, customers, suppliers, stock and attendance — for your accountant or a backup.">
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Field label="From (DD-MM-YYYY)" value={from} onChangeText={setFrom} error={from && !toIso(from) ? 'DD-MM-YYYY' : undefined} />
        <Field label="To (DD-MM-YYYY)" value={to} onChangeText={setTo} error={to && !toIso(to) ? 'DD-MM-YYYY' : undefined} />
      </View>
      <Button title="Download Excel file" icon="download-outline" onPress={() => void go()} busy={busy} disabled={!toIso(from) || !toIso(to)} />
    </Card>
  );
}
