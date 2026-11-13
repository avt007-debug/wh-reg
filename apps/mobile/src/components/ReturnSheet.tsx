/** Goods returned: from a customer (credit note — stock back in, balance down) or to a supplier (debit note). */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { formatINR } from '@wh/shared';
import { rpc } from '../api/client';
import { dmy } from '../lib/dates';
import { notify } from '../lib/dialogs';
import { todayIST } from '../lib/ids';
import { useTheme } from '../theme';
import { Sheet } from './Sheet';
import { Button, Card, Field, Label, Row } from './ui';

interface RLine { line_id: string; line_no: number; sku_code: string; name: string; uom: string; factor: number; qty: number; qty_base: number;
  gst_rate: number; line_taxable: number; returned_base: number; returnable_base: number }
const n = (x: unknown) => Number(x ?? 0);
const toIso = (d: string) => { const m = d.trim().match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/); return m ? `${m[3]}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}` : null; };

export function ReturnSheet({ kind, docId, title, onClose }: { kind: 'sale' | 'purchase'; docId: string | null; title: string; onClose: () => void }) {
  const t = useTheme();
  const qc = useQueryClient();
  const lines = useQuery({ queryKey: ['returnable', kind, docId], enabled: !!docId, queryFn: () => rpc<RLine[]>('returnable_lines', { p_kind: kind, p_doc: docId }) });
  const [qty, setQty] = useState<Record<string, string>>({});
  const [reason, setReason] = useState('');
  const [date, setDate] = useState(dmy(todayIST()));
  useEffect(() => { setQty({}); setReason(''); setDate(dmy(todayIST())); }, [docId]);

  // quantities are typed in the bill's unit (e.g. BOX); the database works in pieces
  const base = (l: RLine) => Math.round(n(qty[l.line_id]) * n(l.factor) * 1000) / 1000;
  const value = (l: RLine) => { const tx = Math.round(n(l.line_taxable) * base(l) / n(l.qty_base) * 100) / 100; return tx + Math.round(tx * n(l.gst_rate)) / 100; };
  const rows = lines.data ?? [];
  const bad = rows.some((l) => base(l) < 0 || base(l) > n(l.returnable_base) || Number.isNaN(base(l)));
  const total = rows.reduce((a, l) => a + (base(l) > 0 ? value(l) : 0), 0);
  const any = rows.some((l) => base(l) > 0);

  const save = useMutation({
    mutationFn: () => rpc<{ return_no: string; total: number }>(kind === 'sale' ? 'create_sales_return' : 'create_purchase_return', { p: {
      [kind === 'sale' ? 'dispatchId' : 'purchaseId']: docId, reason: reason.trim(), returnDate: toIso(date),
      lines: rows.filter((l) => base(l) > 0).map((l) => ({ lineId: l.line_id, qtyBase: base(l) })) } }),
    onSuccess: (r) => {
      notify(kind === 'sale' ? 'Credit note made' : 'Debit note made', `${r.return_no} · ${formatINR(n(r.total))}. ${kind === 'sale'
        ? 'Stock is back and the customer balance went down.' : 'Stock went out and what you owe the supplier went down.'}`);
      for (const k of ['returns', 'sales-month', 'purchases-month', 'owner-ledger', 'owner-customers', 'owner-suppliers', 'owner-stock', 'stock-overview', 'returnable'])
        void qc.invalidateQueries({ queryKey: [k] });
      onClose();
    },
    onError: (e) => notify('Not saved', e instanceof Error ? e.message : String(e)),
  });

  return (
    <Sheet visible={!!docId} title={kind === 'sale' ? 'Goods returned by customer' : 'Goods returned to supplier'} subtitle={title} onClose={onClose}>
      <Label muted>{kind === 'sale'
        ? 'Makes a credit note: the items go back into stock and the customer owes less. Type how many came back.'
        : 'Makes a debit note: the items leave stock and you owe the supplier less. Type how many you sent back.'}</Label>
      {rows.map((l) => (
        <Card key={l.line_id}>
          <Text style={{ color: t.text, fontWeight: '700' }}>{l.line_no}. {l.name}</Text>
          <Label muted>{l.sku_code} · billed {n(l.qty)} {l.uom}{n(l.returned_base) ? ` · already returned ${n(l.returned_base) / n(l.factor)} ${l.uom}` : ''}</Label>
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-end' }}>
            <Field label={`Returned (${l.uom}) — up to ${n(l.returnable_base) / n(l.factor)}`} keyboardType="decimal-pad" value={qty[l.line_id] ?? ''}
              onChangeText={(v) => setQty((s) => ({ ...s, [l.line_id]: v }))} placeholder="0"
              error={base(l) > n(l.returnable_base) ? 'More than was billed' : undefined} />
            <Text style={{ color: t.text, fontWeight: '700', minWidth: 90, textAlign: 'right', paddingBottom: 12 }}>{base(l) > 0 ? formatINR(value(l)) : ''}</Text>
          </View>
        </Card>
      ))}
      {lines.isLoading ? <Label muted>Loading…</Label> : null}
      <Field label="Reason (shown on the note)" value={reason} onChangeText={setReason} placeholder="e.g. damaged, wrong size, extra supplied" />
      <Field label="Return date (DD-MM-YYYY)" value={date} onChangeText={setDate} error={date && !toIso(date) ? 'Use DD-MM-YYYY' : undefined} />
      <Row left={kind === 'sale' ? 'Credit note value (incl. GST)' : 'Debit note value (incl. GST)'} right={formatINR(Math.round(total * 100) / 100)} />
      <Button title={kind === 'sale' ? 'Make credit note' : 'Make debit note'} icon="return-down-back-outline" onPress={() => save.mutate()}
        busy={save.isPending} disabled={!any || bad || reason.trim().length < 3 || !toIso(date)} />
    </Sheet>
  );
}
