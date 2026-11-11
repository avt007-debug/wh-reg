/**
 * Owner: credit notes available — credit % set on purchase lines, per seller
 * and per item. Credit is for future purchases (it does not change what was
 * paid). Record credit when it is used; the balance updates.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { formatINR } from '@wh/shared';
import { rpc } from '../api/client';
import { dmy } from '../lib/dates';
import { confirmAsk, notify } from '../lib/dialogs';
import { exportXlsx } from '../lib/exportFile';
import { fileStamp, useOwnerWarehouse } from '../lib/warehouse';
import { useTheme } from '../theme';
import { Card, Field, Label, Row, SmallButton, Stat, Toolbar } from './ui';

interface VendorCredit {
  vendor_id: string; vendor_name: string; gstin: string | null; earned: number; used: number; available: number; purchases: number;
  items: { product_id: string; sku_code: string; name: string; brand: string | null; category: string | null; earned: number; qty_base: number; avg_pct: number }[];
}
interface Use { id: string; vendor_id: string; vendor_name: string; amount: number; used_on: string; notes: string | null; purchase_invoice_no: string | null }
const n = (x: unknown) => Number(x ?? 0);

export function CreditNotes() {
  const t = useTheme();
  const qc = useQueryClient();
  const wh = useOwnerWarehouse((s) => s.id);
  const q = useQuery({ queryKey: ['credit-summary', wh], queryFn: () => rpc<{ vendors: VendorCredit[]; uses: Use[] }>('owner_credit_summary', { p_warehouse: wh }) });
  const [open, setOpen] = useState<string | null>(null);
  const [using, setUsing] = useState<string | null>(null);
  const [amount, setAmount] = useState('');
  const [notes, setNotes] = useState('');

  const vendors = q.data?.vendors ?? [];
  const earned = vendors.reduce((a, v) => a + n(v.earned), 0);
  const used = vendors.reduce((a, v) => a + n(v.used), 0);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['credit-summary'] });

  const use = useMutation({
    mutationFn: (vendorId: string) => rpc('owner_use_credit', { p: { vendorId, amount: Number(amount), notes: notes.trim() || null } }),
    onSuccess: () => { setUsing(null); setAmount(''); setNotes(''); refresh(); notify('Credit used recorded'); },
    onError: (e) => notify('Not saved', e instanceof Error ? e.message : String(e)),
  });
  const undo = async (u: Use) => {
    if (await confirmAsk(`Delete this credit use?`, `${formatINR(n(u.amount))} from ${u.vendor_name} on ${dmy(u.used_on)}`, 'Delete')) {
      rpc('owner_delete_credit_use', { p_id: u.id }).then(refresh, (e) => notify('Not deleted', e instanceof Error ? e.message : String(e)));
    }
  };

  const doExport = () => exportXlsx(`Credit_notes_${fileStamp()}`, [
    {
      name: 'By seller',
      columns: [{ header: 'Seller', width: 28 }, { header: 'GSTIN', width: 18 }, { header: 'Bills', kind: 'number', width: 7 },
        { header: 'Credit earned', kind: 'money', width: 14 }, { header: 'Used', kind: 'money', width: 12 }, { header: 'Available', kind: 'money', width: 13 }],
      rows: vendors.map((v) => [v.vendor_name, v.gstin, n(v.purchases), n(v.earned), n(v.used), n(v.available)]),
    },
    {
      name: 'By item',
      columns: [{ header: 'Seller', width: 26 }, { header: 'Item code', width: 15 }, { header: 'Item name', width: 30 }, { header: 'Company', width: 14 },
        { header: 'Category', width: 22 }, { header: 'Qty bought', kind: 'number', width: 11 }, { header: 'Avg credit %', kind: 'number', width: 11 },
        { header: 'Credit earned', kind: 'money', width: 14 }],
      rows: vendors.flatMap((v) => v.items.map((i) => [v.vendor_name, i.sku_code, i.name, i.brand, i.category, n(i.qty_base), n(i.avg_pct), n(i.earned)])),
    },
    {
      name: 'Credit used',
      columns: [{ header: 'Date', kind: 'date', width: 12 }, { header: 'Seller', width: 26 }, { header: 'Amount', kind: 'money', width: 12 }, { header: 'Note', width: 30 }],
      rows: (q.data?.uses ?? []).map((u) => [u.used_on, u.vendor_name, n(u.amount), u.notes]),
    },
  ]).catch((e) => notify('Export failed', e instanceof Error ? e.message : String(e)));

  return (
    <>
      <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap' }}>
        <Stat label="Credit available" value={formatINR(earned - used)} sub={`${vendors.length} seller(s)`} />
        <Stat label="Credit earned" value={formatINR(earned)} sub="on approved purchases" />
        <Stat label="Credit used" value={formatINR(used)} />
      </View>
      <Toolbar>
        <SmallButton icon="⬇" title="Export credit notes to Excel" onPress={doExport} disabled={!vendors.length} />
        <Label muted>Credit = credit % × item value before GST. It is for future purchases and does not change what you paid.</Label>
      </Toolbar>

      {vendors.map((v) => (
        <Card key={v.vendor_id}>
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-start' }}>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={{ color: t.text, fontSize: 16, fontWeight: '700' }}>{v.vendor_name}</Text>
              <Label muted>{v.gstin ? `GSTIN ${v.gstin} · ` : ''}{v.purchases} bill(s) · earned {formatINR(n(v.earned))} · used {formatINR(n(v.used))}</Label>
            </View>
            <View style={{ alignItems: 'flex-end' }}>
              <Text style={{ color: n(v.available) > 0 ? t.good : t.textMuted, fontSize: 18, fontWeight: '800' }}>{formatINR(n(v.available))}</Text>
              <Label muted>available</Label>
            </View>
          </View>
          <Toolbar>
            <SmallButton title={open === v.vendor_id ? 'Hide items' : `Items (${v.items.length})`} onPress={() => setOpen(open === v.vendor_id ? null : v.vendor_id)} />
            <SmallButton title="Record credit used" onPress={() => { setUsing(v.vendor_id); setAmount(''); setNotes(''); }} disabled={n(v.available) <= 0} />
          </Toolbar>
          {open === v.vendor_id ? v.items.map((i) => (
            <Row key={i.product_id} left={i.name} sub={`${i.sku_code}${i.brand ? ` · ${i.brand}` : ''}${i.category ? ` · ${i.category}` : ''} · ${n(i.qty_base)} bought · avg ${n(i.avg_pct)}%`}
              right={formatINR(n(i.earned))} />
          )) : null}
          {using === v.vendor_id ? (
            <View style={{ gap: 8 }}>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <Field label={`Amount used (max ${formatINR(n(v.available))})`} keyboardType="decimal-pad" value={amount} onChangeText={setAmount} />
                <Field label="Note" value={notes} onChangeText={setNotes} placeholder="e.g. adjusted in bill SAI-14" />
              </View>
              <Toolbar>
                <SmallButton title="Save" kind="primary" onPress={() => use.mutate(v.vendor_id)}
                  disabled={use.isPending || !(Number(amount) > 0) || Number(amount) > n(v.available)} />
                <SmallButton title="Cancel" onPress={() => setUsing(null)} />
              </Toolbar>
            </View>
          ) : null}
        </Card>
      ))}
      {!vendors.length ? <Label muted>{q.isLoading ? 'Loading…' : 'No credit notes yet — add a credit % when you enter or edit a purchase.'}</Label> : null}

      {(q.data?.uses ?? []).length ? (
        <Card title="Credit used">
          {(q.data?.uses ?? []).map((u) => (
            <Row key={u.id} left={`${u.vendor_name} · ${formatINR(n(u.amount))}`} sub={`${dmy(u.used_on)}${u.notes ? ` · ${u.notes}` : ''}`}
              right={<SmallButton title="Delete" onPress={() => void undo(u)} />} />
          ))}
        </Card>
      ) : null}
    </>
  );
}
