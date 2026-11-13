/** Owner transfers: move stock between any two warehouses, receive on arrival, cancel a wrong one. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { rpc } from '../../src/api/client';
import { toUoms, type ProductHit } from '../../src/api/types';
import { ItemPicker } from '../../src/components/ItemPicker';
import { QtyUomField } from '../../src/components/QtyUomField';
import { Button, Card, Chips, Field, Label, Row, Screen, SmallButton, Toolbar } from '../../src/components/ui';
import { dateTimeIST } from '../../src/lib/dates';
import { askText, notify } from '../../src/lib/dialogs';
import { newClientTxnId } from '../../src/lib/ids';
import { useWarehouses } from '../../src/lib/warehouse';
import { useTheme } from '../../src/theme';

interface Note {
  id: string; note_no: string; status: 'DRAFT' | 'IN_TRANSIT' | 'RECEIVED' | 'CANCELLED'; from_code: string; to_code: string; from_warehouse_id: string; to_warehouse_id: string;
  vehicle_reg_no: string | null; created_at: string; dispatched_at: string | null; received_at: string | null;
  lines: { line_no: number; name: string; qty: number; uom: string; qty_base: number; qty_received_base: number | null }[];
}
const STATUS: Record<string, string> = { DRAFT: 'Draft', IN_TRANSIT: '🚚 On the way', RECEIVED: '✓ Received', CANCELLED: 'Cancelled' };

export default function OwnerTransfers() {
  const t = useTheme();
  const qc = useQueryClient();
  const whs = useWarehouses();
  const notes = useQuery({ queryKey: ['transfers'], queryFn: () => rpc<Note[]>('list_transfers') });
  const [txnId, setTxnId] = useState(newClientTxnId);
  const [from, setFrom] = useState<string | null>(null);
  const [to, setTo] = useState<string | null>(null);
  const [vehicle, setVehicle] = useState('');
  const [lines, setLines] = useState<{ product: ProductHit; uomCode: string; qty: string }[]>([]);
  const [picking, setPicking] = useState(false);
  const refresh = () => { for (const k of ['transfers', 'inventory', 'owner-stock', 'stock-overview']) void qc.invalidateQueries({ queryKey: [k] }); };
  const fail = (e: unknown) => notify('Not done', e instanceof Error ? e.message : String(e));

  const create = useMutation({
    mutationFn: () => rpc<{ note_no: string }>('create_transfer', { p: { clientTxnId: txnId, fromWarehouseId: from, toWarehouseId: to, vehicleRegNo: vehicle || undefined,
      lines: lines.map((l) => ({ productId: l.product.id, uomCode: l.uomCode, qty: Number(l.qty) })) } }),
    onSuccess: (r) => { setTxnId(newClientTxnId()); setLines([]); setVehicle(''); refresh(); notify('Transfer sent', `${r.note_no} — stock left ${whs.data?.find((w) => w.id === from)?.name}. Receive it when it arrives.`); },
    onError: fail,
  });
  const receive = (n: Note) => rpc('receive_transfer', { p_note: n.id }).then(() => { refresh(); notify('Received into stock', n.note_no); }, fail);
  const cancel = async (n: Note) => {
    const why = await askText(`Cancel ${n.note_no}?`, 'The items go back to the sending warehouse. Reason:');
    if (!why?.trim()) return;
    rpc('owner_cancel_transfer', { p_note: n.id, p_reason: why.trim() }).then(() => { refresh(); notify('Transfer cancelled'); }, fail);
  };
  const ids = (whs.data ?? []).map((w) => w.id);
  const name = (id: string) => { const w = whs.data?.find((x) => x.id === id); return w ? `${w.name} (${w.code})` : id; };
  const open = (notes.data ?? []).filter((n) => n.status === 'IN_TRANSIT' || n.status === 'DRAFT');
  const done = (notes.data ?? []).filter((n) => n.status === 'RECEIVED' || n.status === 'CANCELLED').slice(0, 25);

  const NoteCard = ({ n }: { n: Note }) => (
    <Card>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <View style={{ flex: 1 }}>
          <Text style={{ color: t.text, fontWeight: '700' }}>{n.note_no} · {n.from_code} → {n.to_code}</Text>
          <Label muted>{[STATUS[n.status], dateTimeIST(n.dispatched_at ?? n.created_at), n.vehicle_reg_no].filter(Boolean).join(' · ')}</Label>
        </View>
      </View>
      {n.lines.map((l) => <Row key={l.line_no} left={l.name} right={`${Number(l.qty)} ${l.uom}`}
        sub={l.qty_received_base != null && Number(l.qty_received_base) !== Number(l.qty_base) ? `received ${Number(l.qty_received_base)} of ${Number(l.qty_base)} pcs` : undefined} />)}
      {n.status === 'IN_TRANSIT' || n.status === 'DRAFT' ? (
        <Toolbar>
          {n.status === 'IN_TRANSIT' ? <SmallButton icon="checkmark-done-outline" title={`Received at ${n.to_code}`} kind="primary" onPress={() => void receive(n)} /> : null}
          <SmallButton icon="close-circle-outline" title="Cancel transfer" kind="danger" onPress={() => void cancel(n)} />
        </Toolbar>
      ) : null}
    </Card>
  );

  return (
    <Screen>
      <Card title="Move stock between warehouses">
        <Label>From</Label>
        <Chips options={ids} value={from} onChange={(v) => { setFrom(v); if (v === to) setTo(null); }} format={name} />
        <Label>To</Label>
        <Chips options={ids.filter((x) => x !== from)} value={to} onChange={setTo} format={name} />
        <Field label="Vehicle no. (optional)" value={vehicle} onChangeText={(v) => setVehicle(v.toUpperCase())} autoCapitalize="characters" />
        {lines.map((l, i) => (
          <Card key={`${l.product.id}-${i}`}>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <Text style={{ flex: 1, color: t.text, fontWeight: '700' }}>{l.product.name}</Text>
              <SmallButton title="Remove" kind="danger" onPress={() => setLines((ls) => ls.filter((_, j) => j !== i))} />
            </View>
            <QtyUomField uoms={toUoms(l.product)} uomCode={l.uomCode}
              onUomChange={(c) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, uomCode: c } : x)))}
              qty={l.qty} onQtyChange={(v) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, qty: v } : x)))} />
          </Card>
        ))}
        <Button title="Add item" icon="add" kind="secondary" onPress={() => setPicking(true)} />
        <Button title="Send transfer" icon="swap-horizontal-outline" onPress={() => create.mutate()} busy={create.isPending}
          disabled={!from || !to || !lines.length || lines.some((l) => !(Number(l.qty) > 0))} />
      </Card>
      <Card title={`On the way (${open.length})`}>{open.length ? null : <Label muted>Nothing on the way</Label>}</Card>
      {open.map((n) => <NoteCard key={n.id} n={n} />)}
      <Card title="Recent" />
      {done.map((n) => <NoteCard key={n.id} n={n} />)}
      <ItemPicker visible={picking} onClose={() => setPicking(false)}
        onPick={(p) => setLines((ls) => [...ls, { product: p, uomCode: p.uoms.find((u) => Number(u.factor) === 1)?.code ?? 'PCS', qty: '' }])} />
    </Screen>
  );
}
