/**
 * Customers: everyone you bill — edit details, credit limit and due days, merge duplicates, call / WhatsApp,
 * statement. Balances come from bills, payments and credit notes.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Linking, Text, View } from 'react-native';
import { formatINR, isValidGstin } from '@wh/shared';
import { rpc } from '../../src/api/client';
import { useAuth } from '../../src/auth/store';
import { StatementModal } from '../../src/components/Ledger';
import { MergeSheet } from '../../src/components/MergeSheet';
import { Sheet } from '../../src/components/Sheet';
import { Toggle } from '../../src/components/Toggle';
import { Button, Card, Chips, Field, Label, Screen, SmallButton, Stat, Toolbar } from '../../src/components/ui';
import { dmy } from '../../src/lib/dates';
import { notify } from '../../src/lib/dialogs';
import { exportXlsx } from '../../src/lib/exportFile';
import { fileStamp } from '../../src/lib/warehouse';
import { openWhatsApp } from '../../src/lib/whatsapp';
import { useTheme } from '../../src/theme';

export interface Customer {
  id: string; name: string; gstin: string | null; phone: string | null; address: string | null; state_code: string | null; is_dealer: boolean;
  is_active: boolean; notes: string | null; credit_limit: number | null; credit_days: number; billed: number; paid: number; balance: number;
  overdue: number; oldest_overdue_days: number | null; last_bill_date: string | null; last_payment_date: string | null; bills: number; over_limit: boolean;
}
const n = (x: unknown) => Number(x ?? 0);
const VIEWS = ['All', 'Owes money', 'Overdue', 'Over limit', 'Hidden'] as const;

export default function Customers() {
  const t = useTheme();
  const fullOwner = useAuth((s) => s.user?.role) === 'OWNER';
  const list = useQuery({ queryKey: ['owner-customers'], queryFn: () => rpc<Customer[]>('owner_customers') });
  const [view, setView] = useState<(typeof VIEWS)[number]>('All');
  const [search, setSearch] = useState('');
  const [edit, setEdit] = useState<Customer | 'new' | null>(null);
  const [merge, setMerge] = useState<Customer | null>(null);
  const [statement, setStatement] = useState<string | null>(null);

  const all = list.data ?? [];
  const needle = search.trim().toLowerCase();
  const rows = all.filter((c) => (view === 'Hidden' ? !c.is_active : c.is_active)
    && (view !== 'Owes money' || n(c.balance) > 0) && (view !== 'Overdue' || n(c.overdue) > 0) && (view !== 'Over limit' || c.over_limit)
    && (!needle || `${c.name} ${c.gstin ?? ''} ${c.phone ?? ''} ${c.address ?? ''}`.toLowerCase().includes(needle)));
  const owed = all.reduce((a, c) => a + Math.max(0, n(c.balance)), 0);
  const overdue = all.reduce((a, c) => a + n(c.overdue), 0);

  const doExport = () => exportXlsx(`Customers_${fileStamp()}`, [{ name: 'Customers', columns: [
    { header: 'Customer', width: 28 }, { header: 'GSTIN', width: 18 }, { header: 'Phone', width: 13 }, { header: 'Address', width: 30 },
    { header: 'Dealer', width: 8 }, { header: 'Credit limit', kind: 'money', width: 13 }, { header: 'Due days', kind: 'number', width: 9 },
    { header: 'Bills', kind: 'number', width: 7 }, { header: 'Billed', kind: 'money', width: 13 }, { header: 'Paid', kind: 'money', width: 13 },
    { header: 'Balance', kind: 'money', width: 13 }, { header: 'Overdue', kind: 'money', width: 13 }, { header: 'Last bill', kind: 'date', width: 11 },
    { header: 'Last payment', kind: 'date', width: 12 }, { header: 'Notes', width: 30 }],
    rows: rows.map((c) => [c.name, c.gstin, c.phone, c.address, c.is_dealer ? 'Yes' : '', c.credit_limit, c.credit_days, c.bills, n(c.billed), n(c.paid),
      n(c.balance), n(c.overdue), c.last_bill_date, c.last_payment_date, c.notes]) }]).catch((e) => notify('Export failed', String(e)));

  return (
    <Screen>
      <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap' }}>
        <Stat label="Customers" value={String(all.filter((c) => c.is_active).length)} icon="people" />
        <Stat label="To collect" value={formatINR(owed)} icon="wallet" />
        <Stat label="Overdue" value={formatINR(overdue)} tone={overdue ? 'danger' : undefined} icon="alarm" />
      </View>
      <Chips options={VIEWS} value={view} onChange={setView} />
      <Field label="Search name, GSTIN, phone or place" value={search} onChangeText={setSearch} autoCapitalize="none" />
      <Toolbar>
        <SmallButton title="New customer" kind="primary" onPress={() => setEdit('new')} />
        <SmallButton title="Export to Excel" onPress={() => void doExport()} disabled={!rows.length} />
      </Toolbar>
      {rows.map((c) => (
        <Card key={c.id}>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={{ color: t.text, fontSize: 16, fontWeight: '700' }}>{c.name}{c.is_dealer ? '  · dealer' : ''}</Text>
              <Label muted>{[c.gstin ?? 'Unregistered', c.phone, c.address].filter(Boolean).join(' · ')}</Label>
              <Label muted>{`${c.bills} bill(s)${c.last_bill_date ? ` · last ${dmy(c.last_bill_date)}` : ''}${c.credit_limit != null ? ` · limit ${formatINR(n(c.credit_limit))}, ${c.credit_days} days` : ''}`}</Label>
              {c.notes ? <Label muted>📝 {c.notes}</Label> : null}
            </View>
            <View style={{ alignItems: 'flex-end' }}>
              <Text style={{ color: n(c.balance) > 0 ? t.text : t.good, fontWeight: '800', fontSize: 16 }}>{formatINR(n(c.balance))}</Text>
              {n(c.overdue) > 0 ? <Text style={{ color: t.danger, fontSize: 12 }}>{formatINR(n(c.overdue))} overdue · {c.oldest_overdue_days}d</Text> : null}
              {c.over_limit ? <Text style={{ color: t.danger, fontSize: 12, fontWeight: '700' }}>over limit</Text> : null}
            </View>
          </View>
          <Toolbar>
            <SmallButton title="Edit" onPress={() => setEdit(c)} />
            <SmallButton icon="document-text-outline" title="Statement" onPress={() => setStatement(c.id)} />
            {c.phone ? <SmallButton icon="call-outline" title="Call" onPress={() => void Linking.openURL(`tel:${c.phone}`)} /> : null}
            {c.phone ? <SmallButton icon="logo-whatsapp" title="WhatsApp" onPress={() => void openWhatsApp(c.phone, n(c.balance) > 0
              ? `Namaste ${c.name}, a friendly reminder: your balance with us is ${formatINR(n(c.balance))}. Kindly arrange payment. Thank you.` : `Namaste ${c.name}, `)} /> : null}
            {fullOwner ? <SmallButton icon="git-merge-outline" title="Merge" onPress={() => setMerge(c)} /> : null}
          </Toolbar>
        </Card>
      ))}
      {!rows.length ? <Label muted>{list.isLoading ? 'Loading…' : 'No customers here'}</Label> : null}

      <CustomerEditor customer={edit} onClose={() => setEdit(null)} />
      <MergeSheet keep={merge} all={all} onClose={() => setMerge(null)} />
      <StatementModal customerId={statement} onClose={() => setStatement(null)} owner />
    </Screen>
  );
}

function CustomerEditor({ customer, onClose }: { customer: Customer | 'new' | null; onClose: () => void }) {
  const qc = useQueryClient();
  const c = customer && customer !== 'new' ? customer : null;
  const [f, setF] = useState({ name: '', gstin: '', phone: '', address: '', limit: '', days: '30', notes: '', dealer: false, active: true });
  useEffect(() => {
    setF({ name: c?.name ?? '', gstin: c?.gstin ?? '', phone: c?.phone ?? '', address: c?.address ?? '', limit: c?.credit_limit != null ? String(n(c.credit_limit)) : '',
      days: String(c?.credit_days ?? 30), notes: c?.notes ?? '', dealer: c?.is_dealer ?? false, active: c?.is_active ?? true });
  }, [customer]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (k: keyof typeof f) => (v: string | boolean) => setF((s) => ({ ...s, [k]: v }));
  const gstOk = !f.gstin.trim() || isValidGstin(f.gstin.trim().toUpperCase());
  const save = useMutation({
    mutationFn: () => rpc('owner_save_customer', { p: { id: c?.id, name: f.name, gstin: f.gstin.trim().toUpperCase(), phone: f.phone, address: f.address,
      isDealer: f.dealer, isActive: f.active, notes: f.notes, creditLimit: f.limit.trim(), creditDays: f.limit.trim() ? f.days : '30' } }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['owner-customers'] }); void qc.invalidateQueries({ queryKey: ['owner-ledger'] }); notify('Saved'); onClose(); },
    onError: (e) => notify('Not saved', e instanceof Error ? e.message : String(e)),
  });
  return (
    <Sheet visible={!!customer} title={c ? `Edit ${c.name}` : 'New customer'} onClose={onClose}>
      <Card>
        <Field label="Name" value={f.name} onChangeText={set('name')} />
        <Field label="GSTIN (optional)" value={f.gstin} onChangeText={(v) => set('gstin')(v.toUpperCase())} maxLength={15} autoCapitalize="characters"
          error={gstOk ? undefined : 'Not a valid GST number'} />
        <Field label="Mobile" value={f.phone} onChangeText={set('phone')} keyboardType="phone-pad" />
        <Field label="Address with pincode (printed on bills, needed for e-way bills)" value={f.address} onChangeText={set('address')} multiline />
        <Toggle label="Dealer" on={f.dealer} onChange={set('dealer')} />
        <Toggle label="Active" hint="Hidden customers don't show when billing" on={f.active} onChange={set('active')} />
      </Card>
      <Card title="Credit">
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Field label="Credit limit ₹ (blank = no limit)" value={f.limit} onChangeText={set('limit')} keyboardType="decimal-pad" />
          <Field label="Pay within (days)" value={f.days} onChangeText={set('days')} keyboardType="number-pad" />
        </View>
        <Label muted>Employees see a warning when billing a customer who is over the limit or has overdue bills.</Label>
      </Card>
      <Field label="Notes (seen by staff while billing)" value={f.notes} onChangeText={set('notes')} />
      <Button title="Save customer" onPress={() => save.mutate()} busy={save.isPending} disabled={f.name.trim().length < 2 || !gstOk} />
    </Sheet>
  );
}
