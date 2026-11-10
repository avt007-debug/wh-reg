/**
 * Owner sales register, month by month: every bill with who entered it, and how
 * much was GST billed (lines with GST % above 0) vs Non-GST billed (0 % lines).
 * Rate-wise summary, cancel a bill, add a bill, export to Excel.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Modal, ScrollView, Text, View } from 'react-native';
import { formatINR, splitByGst } from '@wh/shared';
import { rpc } from '../../src/api/client';
import { GstSplitRows, GstTag } from '../../src/components/GstSplit';
import { SalesEntryForm } from '../../src/components/SalesEntryForm';
import { Card, Field, Label, Row, Screen, SmallButton, Stat, Toolbar } from '../../src/components/ui';
import { useSelectedWarehouseName, WarehouseSwitch } from '../../src/components/WarehouseSwitch';
import { dateTimeIST, dmy, monthLong, monthStart } from '../../src/lib/dates';
import { askText, notify } from '../../src/lib/dialogs';
import { exportXlsx } from '../../src/lib/exportFile';
import { fileStamp, useOwnerWarehouse } from '../../src/lib/warehouse';
import { useTheme } from '../../src/theme';

interface SaleLine {
  id: string; line_no: number; sku_code: string; name: string; hsn_code: string | null; uom: string; qty: number; mrp: number | null;
  unit_base_price: number; discount_pct: number; discount_amount: number; line_discount: number; line_taxable: number;
  gst_rate: number; line_tax: number; line_total: number;
}
interface Sale {
  id: string; invoice_no: string; invoice_date: string; warehouse_id: string; warehouse_name: string;
  customer_name: string; customer_gstin: string | null; customer_phone: string | null; is_interstate: boolean;
  taxable_total: number; discount_total: number; cgst_total: number; sgst_total: number; igst_total: number; grand_total: number;
  status: 'POSTED' | 'CANCELLED'; cancelled_reason: string | null; used_override: boolean;
  entered_by: string; entered_by_role: string; entered_at: string; lines: SaleLine[];
}
const n = (x: unknown) => Number(x ?? 0);

export default function Sales() {
  const t = useTheme();
  const qc = useQueryClient();
  const wh = useOwnerWarehouse((s) => s.id);
  const whName = useSelectedWarehouseName();
  const [back, setBack] = useState(0);
  const [search, setSearch] = useState('');
  const [adding, setAdding] = useState(false);
  const month = monthStart(back);
  const list = useQuery({ queryKey: ['sales-month', month, wh], queryFn: () => rpc<Sale[]>('owner_sales_month', { p_month: month, p_warehouse: wh }) });

  const needle = search.trim().toLowerCase();
  const rows = (list.data ?? []).filter((s) => !needle
    || `${s.invoice_no} ${s.customer_name} ${s.customer_gstin ?? ''} ${s.entered_by} ${s.lines.map((l) => `${l.sku_code} ${l.name}`).join(' ')}`.toLowerCase().includes(needle));
  const live = rows.filter((s) => s.status === 'POSTED');
  const allLines = live.flatMap((s) => s.lines);
  const split = splitByGst(allLines);
  const total = live.reduce((a, s) => a + n(s.grand_total), 0);
  const gstCollected = live.reduce((a, s) => a + n(s.cgst_total) + n(s.sgst_total) + n(s.igst_total), 0);
  const byRate = new Map<number, { taxable: number; tax: number; total: number }>();
  allLines.forEach((l) => {
    const r = n(l.gst_rate); const b = byRate.get(r) ?? { taxable: 0, tax: 0, total: 0 };
    b.taxable += n(l.line_taxable); b.tax += n(l.line_tax); b.total += n(l.line_total); byRate.set(r, b);
  });
  const rates = [...byRate.entries()].sort((a, b) => a[0] - b[0]);

  const cancel = async (s: Sale) => {
    const reason = (await askText(`Cancel invoice ${s.invoice_no}?`, 'The items go back into stock. Reason:'))?.trim();
    if (!reason) return;
    rpc('owner_cancel_dispatch', { p_id: s.id, p_reason: reason })
      .then(() => { for (const k of ['sales-month', 'owner-stock', 'stock-overview', 'trend-day', 'trend-month', 'top']) void qc.invalidateQueries({ queryKey: [k] }); notify('Invoice cancelled'); },
        (e) => notify('Not cancelled', e instanceof Error ? e.message : String(e)));
  };

  const doExport = () => exportXlsx(`Sales_${month.slice(0, 7)}_${whName.replace(/\s+/g, '-')}_${fileStamp()}`, [
    {
      name: 'Invoices',
      columns: [
        { header: 'Invoice date', kind: 'date', width: 13 }, { header: 'Invoice no', width: 16 }, { header: 'Customer', width: 26 },
        { header: 'Customer GSTIN', width: 18 }, { header: 'Warehouse', width: 13 }, { header: 'Entered by', width: 20 },
        { header: 'GST billed (incl. GST)', kind: 'money', width: 20 }, { header: 'Non-GST billed', kind: 'money', width: 16 },
        { header: 'Discount', kind: 'money', width: 11 }, { header: 'Taxable', kind: 'money', width: 13 },
        { header: 'CGST', kind: 'money', width: 11 }, { header: 'SGST', kind: 'money', width: 11 }, { header: 'IGST', kind: 'money', width: 11 },
        { header: 'Invoice total', kind: 'money', width: 14 }, { header: 'Status', width: 11 },
      ],
      rows: rows.map((s) => {
        const sp = splitByGst(s.lines);
        return [s.invoice_date, s.invoice_no, s.customer_name, s.customer_gstin, s.warehouse_name, s.entered_by,
          sp.gst.total, sp.nonGst.total, n(s.discount_total), n(s.taxable_total), n(s.cgst_total), n(s.sgst_total), n(s.igst_total),
          n(s.grand_total), s.status === 'POSTED' ? 'Active' : `Cancelled: ${s.cancelled_reason ?? ''}`];
      }),
    },
    {
      name: 'Items',
      columns: [
        { header: 'Invoice date', kind: 'date', width: 13 }, { header: 'Invoice no', width: 16 }, { header: 'Customer', width: 24 },
        { header: 'Customer GSTIN', width: 18 }, { header: 'Item code', width: 15 }, { header: 'Item name', width: 30 },
        { header: 'HSN', width: 9 }, { header: 'Qty', kind: 'number', width: 7 }, { header: 'Unit', width: 6 },
        { header: 'MRP', kind: 'money', width: 10 }, { header: 'Price excl. GST', kind: 'money', width: 14 },
        { header: 'Discount ₹', kind: 'money', width: 11 }, { header: 'Taxable', kind: 'money', width: 12 },
        { header: 'GST %', kind: 'number', width: 7 }, { header: 'GST ₹', kind: 'money', width: 11 }, { header: 'Line total', kind: 'money', width: 12 },
        { header: 'Billed as', width: 12 },
      ],
      rows: live.flatMap((s) => s.lines.map((l) => [s.invoice_date, s.invoice_no, s.customer_name, s.customer_gstin, l.sku_code, l.name,
        l.hsn_code, n(l.qty), l.uom, l.mrp != null ? n(l.mrp) : null, n(l.unit_base_price), n(l.line_discount), n(l.line_taxable),
        n(l.gst_rate), n(l.line_tax), n(l.line_total), n(l.gst_rate) > 0 ? 'GST' : 'Non-GST'])),
    },
    {
      name: 'GST rate summary',
      columns: [{ header: 'GST %', kind: 'number', width: 8 }, { header: 'Billed as', width: 12 }, { header: 'Taxable', kind: 'money', width: 14 },
        { header: 'GST ₹', kind: 'money', width: 12 }, { header: 'Total', kind: 'money', width: 14 }],
      rows: rates.map(([r, b]) => [r, r > 0 ? 'GST' : 'Non-GST', Math.round(b.taxable * 100) / 100, Math.round(b.tax * 100) / 100, Math.round(b.total * 100) / 100]),
    },
  ]).catch((e) => notify('Export failed', e instanceof Error ? e.message : String(e)));

  return (
    <Screen>
      <WarehouseSwitch />
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <SmallButton title="‹ Prev" onPress={() => setBack((b) => b + 1)} />
        <Text style={{ flex: 1, textAlign: 'center', color: t.text, fontSize: 18, fontWeight: '700' }}>{monthLong(month)}</Text>
        <SmallButton title="Next ›" onPress={() => setBack((b) => Math.max(0, b - 1))} disabled={back === 0} />
      </View>

      <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap' }}>
        <Stat label="Total sales" value={formatINR(total)} sub={`${live.length} bill(s)`} />
        <Stat label="GST billed" value={formatINR(split.gst.total)} sub={`${split.gst.lines} line(s) · GST ${formatINR(split.gst.tax)}`} />
        <Stat label="Non-GST billed" value={formatINR(split.nonGst.total)} sub={`${split.nonGst.lines} line(s) at 0%`} />
      </View>
      <Card title={`GST by rate · ${whName}`}>
        {rates.map(([r, b]) => (
          <Row key={r} left={r > 0 ? `${r}% — GST billed` : '0% — Non-GST billed'} sub={`taxable ${formatINR(b.taxable)} · GST ${formatINR(b.tax)}`} right={formatINR(b.total)} />
        ))}
        <Row left="GST collected" sub="CGST + SGST + IGST" right={formatINR(gstCollected)} />
        {!rates.length ? <Label muted>No sales yet this month</Label> : null}
      </Card>

      <Field label="Search invoice no, customer, GSTIN, item or employee" value={search} onChangeText={setSearch} autoCapitalize="none" />
      <Toolbar>
        <SmallButton title="＋ New sale" kind="primary" onPress={() => setAdding(true)} />
        <SmallButton icon="⬇" title="Export month to Excel" onPress={doExport} disabled={!rows.length} />
      </Toolbar>

      {rows.map((s) => {
        const sp = splitByGst(s.lines);
        const off = s.status !== 'POSTED';
        return (
          <Card key={s.id}>
            <View style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-start', opacity: off ? 0.55 : 1 }}>
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={{ color: t.text, fontSize: 16, fontWeight: '700' }}>
                  Invoice {s.invoice_no}{off ? '  ·  CANCELLED' : ''}{s.used_override ? '  ·  ⚠ override' : ''}
                </Text>
                <Label>{dmy(s.invoice_date)} · {s.customer_name}{s.customer_gstin ? ` · GSTIN ${s.customer_gstin}` : ' · no GSTIN'} · {s.warehouse_name}</Label>
                <Text style={{ color: t.textSecondary, fontSize: 12 }}>Entered by {s.entered_by} · {dateTimeIST(s.entered_at)}</Text>
                {off && s.cancelled_reason ? <Text style={{ color: t.danger, fontSize: 12 }}>{s.cancelled_reason}</Text> : null}
              </View>
              {!off ? <SmallButton title="Cancel bill" onPress={() => void cancel(s)} /> : null}
            </View>
            {s.lines.map((l) => (
              <View key={l.id} style={{ flexDirection: 'row', gap: 8, paddingVertical: 6, borderBottomWidth: 0.5, borderColor: t.border, opacity: off ? 0.55 : 1 }}>
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={{ color: t.text }}>{l.name}</Text>
                  <Text style={{ color: t.textMuted, fontSize: 12 }}>
                    {l.sku_code}{l.hsn_code ? ` · HSN ${l.hsn_code}` : ''} · {n(l.qty)} {l.uom} × {formatINR(n(l.unit_base_price))}
                    {n(l.line_discount) ? ` − ${formatINR(n(l.line_discount))} disc.` : ''}{l.mrp != null ? ` · MRP ${formatINR(n(l.mrp))}` : ''}
                  </Text>
                  <GstTag rate={l.gst_rate} />
                </View>
                <Text style={{ color: t.text, fontVariant: ['tabular-nums'], fontWeight: '600' }}>{formatINR(n(l.line_total))}</Text>
              </View>
            ))}
            <GstSplitRows gst={sp.gst} nonGst={sp.nonGst} />
            <Row left="Invoice total" sub={s.is_interstate ? `IGST ${formatINR(n(s.igst_total))}` : `CGST ${formatINR(n(s.cgst_total))} · SGST ${formatINR(n(s.sgst_total))}`}
              right={formatINR(n(s.grand_total))} />
          </Card>
        );
      })}
      {!rows.length ? <Label muted>{list.isLoading ? 'Loading…' : `No sales in ${monthLong(month)}`}</Label> : null}

      <Modal visible={adding} animationType="slide" onRequestClose={() => setAdding(false)}>
        <ScrollView style={{ flex: 1, backgroundColor: t.surface }} keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ padding: 16, gap: 12, paddingTop: 40, width: '100%', maxWidth: 760, alignSelf: 'center' }}>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <Text style={{ flex: 1, color: t.text, fontSize: 20, fontWeight: '700' }}>New sale</Text>
            <SmallButton title="Close" onPress={() => setAdding(false)} />
          </View>
          <SalesEntryForm owner onSaved={() => setAdding(false)} />
        </ScrollView>
      </Modal>
    </Screen>
  );
}
