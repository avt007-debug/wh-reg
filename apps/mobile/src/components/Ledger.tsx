/**
 * Customer ledger pieces shared by the owner's Ledger page and the staff
 * Payments page: record a payment, and a customer statement (bills and
 * payments with a running balance, who entered / received each).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Modal, ScrollView, Text, View } from 'react-native';
import { formatINR } from '@wh/shared';
import { rpc } from '../api/client';
import type { Party } from '../api/types';
import { dmy } from '../lib/dates';
import { notify } from '../lib/dialogs';
import { todayIST } from '../lib/ids';
import { openWhatsApp } from '../lib/whatsapp';
import { useTheme } from '../theme';
import { PartyPicker } from './PartyPicker';
import { Button, Card, Chips, Field, Label, Row, SmallButton, pageBg } from './ui';

export const MODES = ['CASH', 'UPI', 'NEFT', 'RTGS', 'IMPS', 'CHEQUE', 'CARD', 'OTHER'] as const;
const n = (x: unknown) => Number(x ?? 0);
const toIso = (d: string) => {
  const m = d.trim().match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  return m ? `${m[3]}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}` : null;
};
export const LEDGER_KEYS = ['owner-ledger', 'my-ledger', 'statement', 'my-dashboard'];

export function PaymentForm({ customer: fixed, onSaved }: { customer?: { id: string; name: string } | null; onSaved?: () => void }) {
  const qc = useQueryClient();
  const [party, setParty] = useState<Party | null>(null);
  const [date, setDate] = useState(dmy(todayIST()));
  const [mode, setMode] = useState<(typeof MODES)[number]>('CASH');
  const [amount, setAmount] = useState('');
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');
  const customerId = fixed?.id ?? party?.id;
  const iso = toIso(date);

  const save = useMutation({
    mutationFn: () => rpc<{ balance: number; overdue: number }>('record_customer_payment', {
      p: { customerId, amount: Number(amount), paidOn: iso, mode, reference: reference.trim() || null, notes: notes.trim() || null },
    }),
    onSuccess: (r) => {
      notify('Payment recorded', `${formatINR(Number(amount))} from ${fixed?.name ?? party?.name}. Balance now ${formatINR(n(r?.balance))}.`);
      setAmount(''); setReference(''); setNotes(''); if (!fixed) setParty(null);
      for (const k of LEDGER_KEYS) void qc.invalidateQueries({ queryKey: [k] });
      onSaved?.();
    },
    onError: (e) => notify('Not saved', e instanceof Error ? e.message : String(e)),
  });

  return (
    <Card title={fixed ? `Record payment from ${fixed.name}` : 'Record a customer payment'}>
      {!fixed ? <PartyPicker kind="customers" value={party} onChange={setParty} /> : null}
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Field label="Date (DD-MM-YYYY)" value={date} onChangeText={setDate} error={date && !iso ? 'Use DD-MM-YYYY' : undefined} />
        <Field label="Amount ₹" keyboardType="decimal-pad" value={amount} onChangeText={setAmount} placeholder="0" />
      </View>
      <Label>Mode of payment</Label>
      <Chips options={MODES} value={mode} onChange={setMode} />
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Field label="Reference (UTR / cheque no.)" value={reference} onChangeText={setReference} />
        <Field label="Note (optional)" value={notes} onChangeText={setNotes} />
      </View>
      <Button title="Save payment" onPress={() => save.mutate()} busy={save.isPending} disabled={!customerId || !iso || !(Number(amount) > 0)} />
    </Card>
  );
}

interface Entry { kind: 'BILL' | 'PAYMENT'; id: string; date: string; ref: string; debit: number; credit: number; outstanding?: number; days_old?: number; by: string; warehouse?: string; notes?: string }
interface Statement {
  customer: { id: string; name: string; gstin: string | null; phone: string | null };
  totals: { billed: number; paid: number; balance: number; overdue: number } | null;
  entries: Entry[];
}

export function StatementModal({ customerId, onClose, owner = false }: { customerId: string | null; onClose: () => void; owner?: boolean }) {
  const t = useTheme();
  const qc = useQueryClient();
  const s = useQuery({ queryKey: ['statement', customerId], enabled: !!customerId, queryFn: () => rpc<Statement>('customer_statement', { p_customer: customerId }) });
  const d = s.data;
  let running = 0;
  const rows = (d?.entries ?? []).map((e) => { running += n(e.debit) - n(e.credit); return { ...e, running }; });
  const del = (id: string) => rpc('owner_delete_payment', { p_id: id })
    .then(() => { for (const k of LEDGER_KEYS) void qc.invalidateQueries({ queryKey: [k] }); }, (e) => notify('Not deleted', e instanceof Error ? e.message : String(e)));

  return (
    <Modal visible={!!customerId} animationType="slide" onRequestClose={onClose}>
      <ScrollView style={[{ flex: 1 }, pageBg(t)]} keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ padding: 16, gap: 12, paddingTop: 40, width: '100%', maxWidth: 820, alignSelf: 'center' }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <View style={{ flex: 1 }}>
            <Text style={{ color: t.text, fontSize: 20, fontWeight: '700' }}>{d?.customer.name ?? '…'}</Text>
            <Label muted>{[d?.customer.gstin && `GSTIN ${d.customer.gstin}`, d?.customer.phone].filter(Boolean).join(' · ')}</Label>
          </View>
          <SmallButton title="Close" onPress={onClose} />
        </View>
        {d?.totals ? (
          <Card>
            <Row left="Billed" right={formatINR(n(d.totals.billed))} />
            <Row left="Paid" right={formatINR(n(d.totals.paid))} />
            <Row left="Balance due" right={formatINR(n(d.totals.balance))} />
            {n(d.totals.overdue) > 0 ? <Row left="⚠ Overdue (more than 30 days)" right={formatINR(n(d.totals.overdue))} /> : null}
            {d.customer.phone && n(d.totals.balance) > 0 ? (
              <SmallButton title="Send reminder on WhatsApp" onPress={() => void openWhatsApp(d.customer.phone,
                `Dear ${d.customer.name}, your pending balance with us is ${formatINR(n(d.totals!.balance))}. Kindly arrange the payment. Thank you.`)} />
            ) : null}
          </Card>
        ) : null}
        {customerId && d ? <PaymentForm customer={{ id: customerId, name: d.customer.name }} /> : null}
        <Card title="Statement">
          {rows.map((e) => (
            <View key={`${e.kind}-${e.id}`} style={{ flexDirection: 'row', gap: 8, paddingVertical: 8, borderBottomWidth: 0.5, borderColor: t.border }}>
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={{ color: t.text, fontWeight: '600' }}>{dmy(e.date)} · {e.kind === 'BILL' ? `Bill ${e.ref}` : `Payment · ${e.ref}`}</Text>
                <Text style={{ color: t.textMuted, fontSize: 12 }}>
                  {e.kind === 'BILL' ? `Entered by ${e.by}${e.warehouse ? ` · ${e.warehouse}` : ''}` : `Received by ${e.by}${e.notes ? ` · ${e.notes}` : ''}`}
                </Text>
                {e.kind === 'BILL' && n(e.outstanding) > 0 ? (
                  <Text style={{ color: n(e.days_old) > 30 ? t.danger : t.warning, fontSize: 12, fontWeight: '600' }}>
                    {formatINR(n(e.outstanding))} unpaid · {e.days_old} days{n(e.days_old) > 30 ? ' — LATE' : ''}
                  </Text>
                ) : e.kind === 'BILL' ? <Text style={{ color: t.good, fontSize: 12 }}>Paid</Text> : null}
              </View>
              <View style={{ alignItems: 'flex-end', gap: 2 }}>
                <Text style={{ color: e.kind === 'BILL' ? t.text : t.good, fontWeight: '700' }}>
                  {e.kind === 'BILL' ? formatINR(n(e.debit)) : `− ${formatINR(n(e.credit))}`}
                </Text>
                <Text style={{ color: t.textMuted, fontSize: 12 }}>bal {formatINR(e.running)}</Text>
                {owner && e.kind === 'PAYMENT' ? <SmallButton title="Delete" onPress={() => void del(e.id)} /> : null}
              </View>
            </View>
          ))}
          {!rows.length ? <Label muted>{s.isLoading ? 'Loading…' : 'No bills or payments yet'}</Label> : null}
        </Card>
      </ScrollView>
    </Modal>
  );
}
