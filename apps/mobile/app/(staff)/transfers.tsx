/**
 * Inter-Warehouse Transfer Notes.
 * Outbound: raise a note from MY warehouse → stock leaves immediately ("in transit").
 * Inbound:  notes addressed to MY warehouse → confirm received qty per line (shortages recorded).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Alert } from 'react-native';
import { q, rpc } from '../../src/api/client';
import { supabase } from '../../src/lib/supabase';
import { toUoms, type Me, type ProductHit, type Warehouse } from '../../src/api/types';
import { ItemPicker } from '../../src/components/ItemPicker';
import { QtyUomField } from '../../src/components/QtyUomField';
import { Button, Card, Chips, Field, Label, Row, Screen } from '../../src/components/ui';
import { newClientTxnId } from '../../src/lib/ids';

interface Note {
  id: string; note_no: string; status: string; from_code: string; to_code: string; to_warehouse_id: string;
  lines: { line_no: number; name: string; qty: number; uom: string; qty_base: number }[];
}

export default function Transfers() {
  const qc = useQueryClient();
  const me = useQuery({ queryKey: ['me'], queryFn: () => rpc<Me>('me') });
  const whs = useQuery({ queryKey: ['warehouses'], queryFn: () => q<Warehouse[]>(supabase.from('warehouses').select('id, code, name, state_code').order('code')) });
  const notes = useQuery({ queryKey: ['transfers'], queryFn: () => rpc<Note[]>('list_transfers') });

  const [txnId, setTxnId] = useState(newClientTxnId);
  const [to, setTo] = useState<string | null>(null);
  const [vehicle, setVehicle] = useState('');
  const [lines, setLines] = useState<{ product: ProductHit; uomCode: string; qty: string }[]>([]);
  const [picking, setPicking] = useState(false);
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['transfers'] }); void qc.invalidateQueries({ queryKey: ['inventory'] }); };

  const create = useMutation({
    mutationFn: () => rpc('create_transfer', { p: {
      clientTxnId: txnId, toWarehouseId: whs.data!.find((w) => w.code === to)!.id, vehicleRegNo: vehicle || undefined,
      lines: lines.map((l) => ({ productId: l.product.id, uomCode: l.uomCode, qty: Number(l.qty) })),
    } }),
    onSuccess: () => { setTxnId(newClientTxnId()); setLines([]); setTo(null); refresh(); Alert.alert('Transfer note dispatched'); },
    onError: (e) => Alert.alert('Could not create transfer', e instanceof Error ? e.message : String(e)),
  });
  const receive = useMutation({
    mutationFn: (id: string) => rpc('receive_transfer', { p_note: id }),   // full qty; partial via p_lines (roadmap UI)
    onSuccess: () => { refresh(); Alert.alert('Received into stock'); },
  });

  const inbound = (notes.data ?? []).filter((n) => n.status === 'IN_TRANSIT' && n.to_warehouse_id === me.data?.warehouse_id);
  const others = (whs.data ?? []).filter((w) => w.id !== me.data?.warehouse_id).map((w) => w.code);

  return (
    <Screen>
      <Card title={`Inbound to ${me.data?.warehouse_code ?? ''}`}>
        {inbound.map((n) => (
          <Card key={n.id} title={`${n.note_no} · from ${n.from_code}`}>
            {n.lines.map((l) => <Row key={l.line_no} left={l.name} right={`${l.qty} ${l.uom}`} />)}
            <Button title="Confirm received" onPress={() => receive.mutate(n.id)} busy={receive.isPending} />
          </Card>
        ))}
        {!inbound.length ? <Label muted>Nothing in transit to you</Label> : null}
      </Card>

      <Card title="New transfer note">
        <Label>To warehouse</Label>
        <Chips options={others} value={to} onChange={setTo} />
        <Field label="Vehicle no." value={vehicle} onChangeText={setVehicle} autoCapitalize="characters" />
        {lines.map((l, i) => (
          <Card key={i} title={l.product.name}>
            <QtyUomField uoms={toUoms(l.product)} uomCode={l.uomCode}
              onUomChange={(c) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, uomCode: c } : x)))}
              qty={l.qty} onQtyChange={(q) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, qty: q } : x)))} />
          </Card>
        ))}
        <Button title="+ Add item" kind="secondary" onPress={() => setPicking(true)} />
        <Button title="Dispatch transfer" onPress={() => create.mutate()} busy={create.isPending}
          disabled={!to || !lines.length || lines.some((l) => !(Number(l.qty) > 0))} />
      </Card>

      <Card title="Recent notes">
        {(notes.data ?? []).slice(0, 15).map((n) => <Row key={n.id} left={n.note_no} sub={`${n.from_code} → ${n.to_code}`} right={n.status.replace('_', ' ')} />)}
      </Card>
      <ItemPicker visible={picking} onClose={() => setPicking(false)}
        onPick={(p) => setLines((ls) => [...ls, { product: p, uomCode: p.uoms.find((u) => u.factor === 1)?.code ?? 'PCS', qty: '' }])} />
    </Screen>
  );
}
