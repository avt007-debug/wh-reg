/**
 * Money: expenses (rent, salary, electricity…), cash book (cash in hand and bank, money in and out each day)
 * and profit & loss for any month.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { formatINR } from '@wh/shared';
import { rpc } from '../../src/api/client';
import { useAuth } from '../../src/auth/store';
import { Button, Card, Chips, Field, Label, Notice, Row, Screen, SmallButton, Stat, Toolbar } from '../../src/components/ui';
import { dmy, monthLong, monthStart } from '../../src/lib/dates';
import { confirmAsk, notify } from '../../src/lib/dialogs';
import { exportXlsx } from '../../src/lib/exportFile';
import { todayIST } from '../../src/lib/ids';
import { fileStamp, useWarehouses } from '../../src/lib/warehouse';
import { useTheme } from '../../src/theme';

const n = (x: unknown) => Number(x ?? 0);
const CATS = ['Rent', 'Salary', 'Electricity', 'Transport / freight', 'Loading / hamali', 'Fuel', 'Phone / internet', 'Repairs', 'Office', 'Tea / food', 'Bank charges', 'Other'];
const MODES = ['CASH', 'UPI', 'NEFT', 'CHEQUE', 'CARD', 'OTHER'] as const;
const toIso = (d: string) => { const m = d.trim().match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/); return m ? `${m[3]}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}` : null; };
const monthEnd = (m: string) => { const d = new Date(`${m}T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + 1); d.setUTCDate(0); return d.toISOString().slice(0, 10); };

interface Exp { id: string; spent_on: string; category: string; amount: number; mode: string; paid_to: string | null; notes: string | null; warehouse: string | null; by: string }
interface CashBook { opening: { cash: number; bank: number }; in: { cash: number; bank: number }; out: { cash: number; bank: number }; closing: { cash: number; bank: number };
  entries: { date: string; kind: string; party: string; ref: string | null; mode: string; amount: number }[]; opening_set: boolean }
interface Pnl { sales: number; returns: number; net_sales: number; cogs: number; gross_profit: number; gross_margin_pct: number | null; charges_billed: number;
  supplier_credits_used: number; expenses: number; expenses_by_category: { category: string; amount: number }[]; net_profit: number; items_without_cost: number }

export default function Money() {
  const t = useTheme();
  const fullOwner = useAuth((s) => s.user?.role) === 'OWNER';
  const [tab, setTab] = useState<'Expenses' | 'Cash book' | 'Profit & loss'>('Expenses');
  const [back, setBack] = useState(0);
  const month = monthStart(back);
  const to = back === 0 ? todayIST() : monthEnd(month);
  return (
    <Screen>
      <Chips options={(fullOwner ? ['Expenses', 'Cash book', 'Profit & loss'] : ['Expenses']) as ('Expenses' | 'Cash book' | 'Profit & loss')[]} value={tab} onChange={setTab} />
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <SmallButton title="‹ Prev" onPress={() => setBack((b) => b + 1)} />
        <Text style={{ flex: 1, textAlign: 'center', color: t.text, fontSize: 18, fontWeight: '700' }}>{monthLong(month)}</Text>
        <SmallButton title="Next ›" onPress={() => setBack((b) => Math.max(0, b - 1))} disabled={back === 0} />
      </View>
      {tab === 'Expenses' ? <Expenses from={month} to={to} /> : tab === 'Cash book' ? <CashBookView from={month} to={to} /> : <PnlView from={month} to={to} />}
    </Screen>
  );
}

function Expenses({ from, to }: { from: string; to: string }) {
  const t = useTheme();
  const qc = useQueryClient();
  const whs = useWarehouses();
  const list = useQuery({ queryKey: ['expenses', from, to], queryFn: () => rpc<{ items: Exp[]; by_category: { category: string; amount: number }[]; categories: string[] }>('owner_expenses', { p_from: from, p_to: to }) });
  const [cat, setCat] = useState('Electricity'); const [other, setOther] = useState('');
  const [amount, setAmount] = useState(''); const [mode, setMode] = useState<(typeof MODES)[number]>('CASH');
  const [paidTo, setPaidTo] = useState(''); const [notes, setNotes] = useState(''); const [date, setDate] = useState(dmy(todayIST()));
  const [wh, setWh] = useState<string | null>(null);
  const cats = [...new Set([...CATS, ...(list.data?.categories ?? [])])];
  const category = cat === 'Other' && other.trim() ? other.trim() : cat;
  const add = useMutation({
    mutationFn: () => rpc('owner_add_expense', { p: { category, amount, mode, paidTo, notes, spentOn: toIso(date), warehouseId: wh } }),
    onSuccess: () => { notify('Expense saved', `${category} · ${formatINR(n(amount))}`); setAmount(''); setPaidTo(''); setNotes(''); void qc.invalidateQueries({ queryKey: ['expenses'] }); void qc.invalidateQueries({ queryKey: ['cash-book'] }); void qc.invalidateQueries({ queryKey: ['pnl'] }); },
    onError: (e) => notify('Not saved', e instanceof Error ? e.message : String(e)),
  });
  const del = async (e: Exp) => {
    if (!(await confirmAsk('Delete this expense?', `${e.category} · ${formatINR(n(e.amount))} on ${dmy(e.spent_on)}`, 'Delete'))) return;
    rpc('owner_delete_expense', { p_id: e.id }).then(() => void qc.invalidateQueries({ queryKey: ['expenses'] }), (x) => notify('Not deleted', x instanceof Error ? x.message : String(x)));
  };
  const total = (list.data?.items ?? []).reduce((a, e) => a + n(e.amount), 0);
  const doExport = () => exportXlsx(`Expenses_${from.slice(0, 7)}_${fileStamp()}`, [{ name: 'Expenses', columns: [{ header: 'Date', kind: 'date', width: 11 },
    { header: 'Category', width: 18 }, { header: 'Amount', kind: 'money', width: 12 }, { header: 'Paid by', width: 8 }, { header: 'Paid to', width: 22 },
    { header: 'Warehouse', width: 10 }, { header: 'Notes', width: 30 }, { header: 'Entered by', width: 18 }],
    rows: (list.data?.items ?? []).map((e) => [e.spent_on, e.category, n(e.amount), e.mode, e.paid_to, e.warehouse, e.notes, e.by]) }]);
  return (
    <>
      <Card title="Add an expense">
        <Chips options={cats} value={cat} onChange={setCat} />
        {cat === 'Other' ? <Field label="What was it for?" value={other} onChangeText={setOther} /> : null}
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Field label="Amount ₹" value={amount} onChangeText={setAmount} keyboardType="decimal-pad" />
          <Field label="Date (DD-MM-YYYY)" value={date} onChangeText={setDate} error={date && !toIso(date) ? 'DD-MM-YYYY' : undefined} />
        </View>
        <Chips options={MODES} value={mode} onChange={setMode} format={(m) => (m === 'CASH' ? 'Cash' : m)} />
        <Field label="Paid to (optional)" value={paidTo} onChangeText={setPaidTo} placeholder="e.g. APSPDCL, landlord" />
        <Label>Warehouse (optional)</Label>
        <Chips options={['', ...(whs.data ?? []).map((w) => w.id)]} value={wh ?? ''} onChange={(v) => setWh(v || null)} format={(v) => (v ? whs.data?.find((w) => w.id === v)?.name ?? v : 'Both / office')} />
        <Field label="Notes (optional)" value={notes} onChangeText={setNotes} />
        <Button title="Save expense" icon="wallet-outline" onPress={() => add.mutate()} busy={add.isPending} disabled={!(n(amount) > 0) || !toIso(date) || category.length < 2} />
      </Card>
      <Card title={`Spent this month: ${formatINR(total)}`}>
        {(list.data?.by_category ?? []).map((c) => <Row key={c.category} left={c.category} right={formatINR(n(c.amount))} />)}
        <Toolbar><SmallButton title="Export to Excel" onPress={() => void doExport()} disabled={!list.data?.items.length} /></Toolbar>
      </Card>
      {(list.data?.items ?? []).map((e) => (
        <View key={e.id} style={{ flexDirection: 'row', gap: 8, paddingVertical: 8, borderBottomWidth: 0.5, borderColor: t.border, alignItems: 'center' }}>
          <View style={{ flex: 1 }}>
            <Text style={{ color: t.text, fontWeight: '600' }}>{e.category}{e.paid_to ? ` · ${e.paid_to}` : ''}</Text>
            <Label muted>{[dmy(e.spent_on), e.mode, e.warehouse, e.notes, e.by].filter(Boolean).join(' · ')}</Label>
          </View>
          <Text style={{ color: t.text, fontWeight: '700' }}>{formatINR(n(e.amount))}</Text>
          <SmallButton title="Delete" kind="danger" onPress={() => void del(e)} />
        </View>
      ))}
    </>
  );
}

function CashBookView({ from, to }: { from: string; to: string }) {
  const t = useTheme();
  const qc = useQueryClient();
  const cb = useQuery({ queryKey: ['cash-book', from, to], queryFn: () => rpc<CashBook>('owner_cash_book', { p_from: from, p_to: to }) });
  const biz = useQuery({ queryKey: ['business-settings'], queryFn: () => rpc<Record<string, unknown>>('owner_business_settings') });
  const [oc, setOc] = useState(''); const [ob, setOb] = useState(''); const [od, setOd] = useState('');
  const saveOpening = useMutation({
    mutationFn: () => rpc('owner_save_business', { p: { ...(biz.data ?? {}), opening_cash: oc, opening_bank: ob, opening_date: toIso(od) } }),
    onSuccess: () => { notify('Opening balance saved'); void qc.invalidateQueries({ queryKey: ['cash-book'] }); void qc.invalidateQueries({ queryKey: ['business-settings'] }); },
    onError: (e) => notify('Not saved', e instanceof Error ? e.message : String(e)),
  });
  const d = cb.data;
  const LABEL: Record<string, string> = { RECEIVED: 'Received from', PAID_SUPPLIER: 'Paid to supplier', EXPENSE: 'Expense' };
  return (
    <>
      {d && !d.opening_set ? (
        <Card title="Starting balance" subtitle="Enter the cash in hand and bank balance on the day you started using the app — once">
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Field label="Cash in hand ₹" value={oc} onChangeText={setOc} keyboardType="decimal-pad" />
            <Field label="Bank ₹" value={ob} onChangeText={setOb} keyboardType="decimal-pad" />
          </View>
          <Field label="As on date (DD-MM-YYYY)" value={od} onChangeText={setOd} placeholder={dmy(todayIST())} />
          <Button title="Save starting balance" onPress={() => saveOpening.mutate()} busy={saveOpening.isPending} disabled={!toIso(od)} />
        </Card>
      ) : null}
      {d ? (
        <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap' }}>
          <Stat label="Cash in hand now" value={formatINR(n(d.closing.cash))} sub={`opening ${formatINR(n(d.opening.cash))} · in ${formatINR(n(d.in.cash))} · out ${formatINR(n(d.out.cash))}`} icon="cash" />
          <Stat label="Bank / UPI" value={formatINR(n(d.closing.bank))} sub={`opening ${formatINR(n(d.opening.bank))} · in ${formatINR(n(d.in.bank))} · out ${formatINR(n(d.out.bank))}`} icon="card" />
        </View>
      ) : null}
      <Notice icon="information-circle-outline">Money in = customer payments. Money out = supplier payments and expenses. Credit / debit notes from returns are not cash, so they are left out.</Notice>
      {(d?.entries ?? []).map((e, i) => (
        <View key={i} style={{ flexDirection: 'row', gap: 8, paddingVertical: 7, borderBottomWidth: 0.5, borderColor: t.border }}>
          <View style={{ flex: 1 }}>
            <Text style={{ color: t.text }}>{LABEL[e.kind] ?? e.kind} {e.party}</Text>
            <Label muted>{[dmy(e.date), e.mode === 'CASH' ? 'Cash' : e.mode, e.ref].filter(Boolean).join(' · ')}</Label>
          </View>
          <Text style={{ color: n(e.amount) >= 0 ? t.good : t.danger, fontWeight: '700' }}>{n(e.amount) >= 0 ? '+' : '−'}{formatINR(Math.abs(n(e.amount)))}</Text>
        </View>
      ))}
      {d && !d.entries.length ? <Label muted>No money in or out this month</Label> : null}
    </>
  );
}

function PnlView({ from, to }: { from: string; to: string }) {
  const p = useQuery({ queryKey: ['pnl', from, to], queryFn: () => rpc<Pnl>('owner_pnl', { p_from: from, p_to: to }) });
  const d = p.data;
  if (!d) return <Label muted>Loading…</Label>;
  return (
    <>
      <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap' }}>
        <Stat label="Net profit" value={formatINR(n(d.net_profit))} tone={n(d.net_profit) < 0 ? 'danger' : 'good'} icon="trending-up" />
        <Stat label="Gross margin" value={d.gross_margin_pct != null ? `${n(d.gross_margin_pct)}%` : '—'} icon="pie-chart" />
      </View>
      <Card title="Profit & loss" subtitle="All amounts without GST">
        <Row left="Sales" right={formatINR(n(d.sales))} />
        {n(d.returns) ? <Row left="Less: goods returned" right={`−${formatINR(n(d.returns))}`} /> : null}
        <Row left="Cost of goods sold" sub="average purchase cost of the items sold" right={`−${formatINR(n(d.cogs))}`} />
        <Row left="Gross profit" right={formatINR(n(d.gross_profit))} />
        {n(d.charges_billed) ? <Row left="Add: loading / transport charges billed" right={formatINR(n(d.charges_billed))} /> : null}
        {n(d.supplier_credits_used) ? <Row left="Add: supplier credit notes used" right={formatINR(n(d.supplier_credits_used))} /> : null}
        <Row left="Less: expenses" right={`−${formatINR(n(d.expenses))}`} />
        {d.expenses_by_category.map((c) => <Row key={c.category} left={`   ${c.category}`} right={formatINR(n(c.amount))} />)}
        <Row left="Net profit" right={formatINR(n(d.net_profit))} />
      </Card>
      {n(d.items_without_cost) > 0 ? (
        <Notice tone="warning">{`${d.items_without_cost} item(s) sold this month have no purchase cost yet (only opening stock), so their cost is counted as ₹0 and profit looks higher. It corrects itself once you enter purchases for them.`}</Notice>
      ) : null}
    </>
  );
}
