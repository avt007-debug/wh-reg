/**
 * Suppliers: what you owe each one (purchases − your discounts − payments − debit notes − credit notes used),
 * overdue bills, record a payment, statement, edit details (usual discount %, credit days), merge duplicates.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Linking, Text, View } from 'react-native';
import { formatINR, isValidGstin } from '@wh/shared';
import { rpc } from '../../src/api/client';
import { useAuth } from '../../src/auth/store';
import { MergeSheet } from '../../src/components/MergeSheet';
import { Sheet } from '../../src/components/Sheet';
import { Toggle } from '../../src/components/Toggle';
import { Button, Card, Chips, Field, Label, Row, Screen, SmallButton, Stat, Toolbar } from '../../src/components/ui';
import { dmy } from '../../src/lib/dates';
import { confirmAsk, notify } from '../../src/lib/dialogs';
import { exportXlsx } from '../../src/lib/exportFile';
import { todayIST } from '../../src/lib/ids';
import { fileStamp } from '../../src/lib/warehouse';
import { openWhatsApp } from '../../src/lib/whatsapp';
import { useTheme } from '../../src/theme';

interface Supplier {
  id: string; name: string; gstin: string | null; phone: string | null; address: string | null; state_code: string | null; is_active: boolean;
  default_discount_pct: number; credit_days: number; notes: string | null; purchases: number; purchased: number; outstanding: number; overdue: number;
  oldest_overdue_days: number | null; paid: number; debit_notes: number; credits_used: number; balance: number; last_purchase: string | null; last_payment: string | null;
}
interface Entry { kind: 'BILL' | 'PAYMENT' | 'DEBIT_NOTE' | 'CREDIT_USED'; id: string; date: string; ref: string; debit: number; credit: number;
  outstanding?: number; days_old?: number; warehouse?: string; notes?: string | null; by?: string }
const n = (x: unknown) => Number(x ?? 0);
const MODES = ['CASH', 'UPI', 'NEFT', 'RTGS', 'IMPS', 'CHEQUE', 'CARD', 'OTHER'] as const;
const toIso = (d: string) => { const m = d.trim().match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/); return m ? `${m[3]}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}` : null; };

export default function Suppliers() {
  const t = useTheme();
  const fullOwner = useAuth((s) => s.user?.role) === 'OWNER';
  const list = useQuery({ queryKey: ['owner-suppliers'], queryFn: () => rpc<Supplier[]>('owner_suppliers') });
  const [view, setView] = useState<'All' | 'We owe' | 'Overdue' | 'Hidden'>('All');
  const [search, setSearch] = useState('');
  const [edit, setEdit] = useState<Supplier | 'new' | null>(null);
  const [open, setOpen] = useState<Supplier | null>(null);
  const [merge, setMerge] = useState<Supplier | null>(null);
  const all = list.data ?? [];
  const needle = search.trim().toLowerCase();
  const rows = all.filter((s) => (view === 'Hidden' ? !s.is_active : s.is_active) && (view !== 'We owe' || n(s.balance) > 0) && (view !== 'Overdue' || n(s.overdue) > 0)
    && (!needle || `${s.name} ${s.gstin ?? ''} ${s.phone ?? ''}`.toLowerCase().includes(needle)));
  const owe = all.reduce((a, s) => a + Math.max(0, n(s.balance)), 0);
  const overdue = all.reduce((a, s) => a + n(s.overdue), 0);

  const doExport = () => exportXlsx(`Suppliers_${fileStamp()}`, [{ name: 'Suppliers', columns: [
    { header: 'Supplier', width: 28 }, { header: 'GSTIN', width: 18 }, { header: 'Phone', width: 13 }, { header: 'Usual discount %', kind: 'number', width: 10 },
    { header: 'Credit days', kind: 'number', width: 9 }, { header: 'Bills', kind: 'number', width: 7 }, { header: 'Purchased', kind: 'money', width: 13 },
    { header: 'Paid', kind: 'money', width: 13 }, { header: 'Debit notes', kind: 'money', width: 12 }, { header: 'Credit used', kind: 'money', width: 12 },
    { header: 'We owe', kind: 'money', width: 13 }, { header: 'Overdue', kind: 'money', width: 12 }, { header: 'Last purchase', kind: 'date', width: 12 },
    { header: 'Last payment', kind: 'date', width: 12 }],
    rows: rows.map((s) => [s.name, s.gstin, s.phone, n(s.default_discount_pct), s.credit_days, s.purchases, n(s.purchased), n(s.paid), n(s.debit_notes),
      n(s.credits_used), n(s.balance), n(s.overdue), s.last_purchase, s.last_payment]) }]).catch((e) => notify('Export failed', String(e)));

  return (
    <Screen>
      <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap' }}>
        <Stat label="We owe suppliers" value={formatINR(owe)} icon="card" />
        <Stat label="Past due date" value={formatINR(overdue)} tone={overdue ? 'danger' : undefined} icon="alarm" />
        <Stat label="Suppliers" value={String(all.filter((s) => s.is_active).length)} icon="business" />
      </View>
      <Chips options={['All', 'We owe', 'Overdue', 'Hidden'] as const} value={view} onChange={setView} />
      <Field label="Search name, GSTIN or phone" value={search} onChangeText={setSearch} autoCapitalize="none" />
      <Toolbar>
        <SmallButton title="New supplier" kind="primary" onPress={() => setEdit('new')} />
        <SmallButton title="Export to Excel" onPress={() => void doExport()} disabled={!rows.length} />
      </Toolbar>
      {rows.map((s) => (
        <Card key={s.id}>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={{ color: t.text, fontSize: 16, fontWeight: '700' }}>{s.name}</Text>
              <Label muted>{[s.gstin ?? 'No GSTIN', s.phone].filter(Boolean).join(' · ')}</Label>
              <Label muted>{`${s.purchases} bill(s) · usual discount ${n(s.default_discount_pct)}% · pay within ${s.credit_days} days${s.last_payment ? ` · last paid ${dmy(s.last_payment)}` : ''}`}</Label>
            </View>
            <View style={{ alignItems: 'flex-end' }}>
              <Text style={{ color: n(s.balance) > 0 ? t.text : t.good, fontWeight: '800', fontSize: 16 }}>{formatINR(n(s.balance))}</Text>
              {n(s.overdue) > 0 ? <Text style={{ color: t.danger, fontSize: 12 }}>{formatINR(n(s.overdue))} past due · {s.oldest_overdue_days}d</Text> : null}
            </View>
          </View>
          <Toolbar>
            <SmallButton icon="document-text-outline" title={fullOwner ? 'Statement & pay' : 'Statement'} onPress={() => setOpen(s)} />
            <SmallButton title="Edit" onPress={() => setEdit(s)} />
            {s.phone ? <SmallButton icon="call-outline" title="Call" onPress={() => void Linking.openURL(`tel:${s.phone}`)} /> : null}
            {s.phone ? <SmallButton icon="logo-whatsapp" title="WhatsApp" onPress={() => void openWhatsApp(s.phone, `Namaste ${s.name}, `)} /> : null}
            {fullOwner ? <SmallButton icon="git-merge-outline" title="Merge" onPress={() => setMerge(s)} /> : null}
          </Toolbar>
        </Card>
      ))}
      {!rows.length ? <Label muted>{list.isLoading ? 'Loading…' : 'No suppliers here'}</Label> : null}
      <SupplierEditor supplier={edit} onClose={() => setEdit(null)} />
      <SupplierStatement supplier={open} canPay={fullOwner} onClose={() => setOpen(null)} />
      <MergeSheet kind="supplier" keep={merge} all={all} onClose={() => setMerge(null)} />
    </Screen>
  );
}

function SupplierEditor({ supplier, onClose }: { supplier: Supplier | 'new' | null; onClose: () => void }) {
  const qc = useQueryClient();
  const s = supplier && supplier !== 'new' ? supplier : null;
  const [f, setF] = useState({ name: '', gstin: '', phone: '', address: '', disc: '0', days: '30', notes: '', active: true });
  useEffect(() => {
    setF({ name: s?.name ?? '', gstin: s?.gstin ?? '', phone: s?.phone ?? '', address: s?.address ?? '', disc: String(n(s?.default_discount_pct)),
      days: String(s?.credit_days ?? 30), notes: s?.notes ?? '', active: s?.is_active ?? true });
  }, [supplier]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (k: keyof typeof f) => (v: string | boolean) => setF((x) => ({ ...x, [k]: v }));
  const gstOk = !f.gstin.trim() || isValidGstin(f.gstin.trim().toUpperCase());
  const discOk = n(f.disc) >= 0 && n(f.disc) <= 100;
  const save = useMutation({
    mutationFn: () => rpc('owner_save_vendor', { p: { id: s?.id, name: f.name, gstin: f.gstin.trim().toUpperCase(), phone: f.phone, address: f.address,
      defaultDiscountPct: f.disc, creditDays: f.days, notes: f.notes, isActive: f.active } }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['owner-suppliers'] }); notify('Saved'); onClose(); },
    onError: (e) => notify('Not saved', e instanceof Error ? e.message : String(e)),
  });
  return (
    <Sheet visible={!!supplier} title={s ? `Edit ${s.name}` : 'New supplier'} onClose={onClose}>
      <Card>
        <Field label="Name" value={f.name} onChangeText={set('name')} />
        <Field label="GSTIN" value={f.gstin} onChangeText={(v) => set('gstin')(v.toUpperCase())} maxLength={15} autoCapitalize="characters" error={gstOk ? undefined : 'Not a valid GST number'} />
        <Field label="Phone" value={f.phone} onChangeText={set('phone')} keyboardType="phone-pad" />
        <Field label="Address" value={f.address} onChangeText={set('address')} multiline />
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Field label="Usual discount % off list price" value={f.disc} onChangeText={set('disc')} keyboardType="decimal-pad" error={discOk ? undefined : '0–100'} />
          <Field label="We pay within (days)" value={f.days} onChangeText={set('days')} keyboardType="number-pad" />
        </View>
        <Label muted>When you add an item to a purchase from this supplier, the price starts at the list price minus this discount.</Label>
        <Field label="Notes" value={f.notes} onChangeText={set('notes')} />
        <Toggle label="Active" on={f.active} onChange={set('active')} />
      </Card>
      <Button title="Save supplier" onPress={() => save.mutate()} busy={save.isPending} disabled={f.name.trim().length < 2 || !gstOk || !discOk} />
    </Sheet>
  );
}

function SupplierStatement({ supplier, canPay, onClose }: { supplier: Supplier | null; canPay: boolean; onClose: () => void }) {
  const t = useTheme();
  const qc = useQueryClient();
  const st = useQuery({ queryKey: ['supplier-statement', supplier?.id], enabled: !!supplier,
    queryFn: () => rpc<{ supplier: Supplier; entries: Entry[] }>('owner_supplier_statement', { p_vendor: supplier!.id }) });
  const [amount, setAmount] = useState(''); const [mode, setMode] = useState<(typeof MODES)[number]>('NEFT');
  const [ref, setRef] = useState(''); const [date, setDate] = useState(dmy(todayIST())); const [notes, setNotes] = useState('');
  useEffect(() => { setAmount(''); setRef(''); setNotes(''); setDate(dmy(todayIST())); }, [supplier]);
  const refresh = () => { for (const k of ['owner-suppliers', 'supplier-statement']) void qc.invalidateQueries({ queryKey: [k] }); };
  const pay = useMutation({
    mutationFn: () => rpc('owner_record_vendor_payment', { p: { vendorId: supplier!.id, amount, mode, reference: ref, notes, paidOn: toIso(date) } }),
    onSuccess: () => { notify('Payment saved', `${formatINR(n(amount))} to ${supplier!.name}`); setAmount(''); setRef(''); setNotes(''); refresh(); },
    onError: (e) => notify('Not saved', e instanceof Error ? e.message : String(e)),
  });
  const del = async (e: Entry) => {
    if (!(await confirmAsk('Delete this payment?', `${formatINR(n(e.debit))} on ${dmy(e.date)}`, 'Delete'))) return;
    rpc('owner_delete_vendor_payment', { p_id: e.id }).then(refresh, (x) => notify('Not deleted', x instanceof Error ? x.message : String(x)));
  };
  const s = st.data?.supplier ?? supplier;
  let run = 0;
  return (
    <Sheet visible={!!supplier} title={supplier?.name ?? ''} subtitle={s ? `We owe ${formatINR(n(s.balance))}` : ''} onClose={onClose}>
      {s ? (
        <Card>
          <Row left="Purchases (after your discounts)" right={formatINR(n(s.purchased))} />
          <Row left="Paid" right={`−${formatINR(n(s.paid))}`} />
          {n(s.debit_notes) ? <Row left="Goods returned (debit notes)" right={`−${formatINR(n(s.debit_notes))}`} /> : null}
          {n(s.credits_used) ? <Row left="Credit notes used" right={`−${formatINR(n(s.credits_used))}`} /> : null}
          <Row left="We owe" right={formatINR(n(s.balance))} />
        </Card>
      ) : null}
      {canPay ? (
        <Card title="Record a payment">
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Field label="Amount ₹" value={amount} onChangeText={setAmount} keyboardType="decimal-pad" />
            <Field label="Date (DD-MM-YYYY)" value={date} onChangeText={setDate} error={date && !toIso(date) ? 'DD-MM-YYYY' : undefined} />
          </View>
          <Chips options={MODES} value={mode} onChange={setMode} />
          <Field label="Cheque / UTR / reference" value={ref} onChangeText={setRef} />
          <Field label="Notes" value={notes} onChangeText={setNotes} />
          <Button title="Save payment" icon="cash-outline" onPress={() => pay.mutate()} busy={pay.isPending} disabled={!(n(amount) > 0) || !toIso(date)} />
        </Card>
      ) : null}
      <Card title="Statement" subtitle="Bills add to what we owe; payments, returns and credits reduce it">
        {(st.data?.entries ?? []).map((e) => {
          run += n(e.credit) - n(e.debit);
          return (
            <View key={`${e.kind}-${e.id}`} style={{ flexDirection: 'row', gap: 8, paddingVertical: 6, borderBottomWidth: 0.5, borderColor: t.border }}>
              <View style={{ flex: 1 }}>
                <Text style={{ color: t.text, fontWeight: '600' }}>{dmy(e.date)} · {e.kind === 'BILL' ? `Bill ${e.ref}` : e.kind === 'DEBIT_NOTE' ? `Debit note ${e.ref}` : e.kind === 'CREDIT_USED' ? 'Credit note used' : `Paid · ${e.ref}`}</Text>
                <Label muted>{[e.warehouse, e.kind === 'BILL' && n(e.outstanding) > 0 ? `unpaid ${formatINR(n(e.outstanding))} · ${e.days_old} days` : null, e.notes, e.by].filter(Boolean).join(' · ')}</Label>
              </View>
              <View style={{ alignItems: 'flex-end' }}>
                <Text style={{ color: n(e.credit) ? t.text : t.good, fontWeight: '700' }}>{n(e.credit) ? formatINR(n(e.credit)) : `−${formatINR(n(e.debit))}`}</Text>
                <Text style={{ color: t.textMuted, fontSize: 12 }}>{formatINR(run)}</Text>
                {e.kind === 'PAYMENT' && canPay ? <SmallButton title="Delete" kind="danger" onPress={() => void del(e)} /> : null}
              </View>
            </View>
          );
        })}
        {st.isLoading ? <Label muted>Loading…</Label> : null}
      </Card>
    </Sheet>
  );
}
