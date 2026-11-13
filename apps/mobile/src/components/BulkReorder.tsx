/** Set reorder levels for many items at once: a fixed number, or from how fast each item sells. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { View } from 'react-native';
import { rpc } from '../api/client';
import { notify } from '../lib/dialogs';
import { useWarehouses } from '../lib/warehouse';
import { Sheet } from './Sheet';
import { Button, Chips, Field, Label } from './ui';

export function BulkReorder({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const whs = useWarehouses();
  const tree = useQuery({ queryKey: ['catalog-tree'], staleTime: 600_000, queryFn: () => rpc<{ brands: { id: string; name: string }[] }>('catalog_tree') });
  const [wh, setWh] = useState(''); const [brand, setBrand] = useState('');
  const [mode, setMode] = useState<'SALES' | 'FIXED'>('SALES');
  const [min, setMin] = useState(''); const [qty, setQty] = useState('');
  const [days, setDays] = useState('90'); const [cover, setCover] = useState('30');
  const save = useMutation({
    mutationFn: () => rpc<{ rules: number }>('owner_bulk_reorder', { p: { warehouseId: wh || null, brandId: brand || null, mode, minQty: min, reorderQty: qty, days, coverDays: cover } }),
    onSuccess: (r) => { notify('Reorder levels set', `${r.rules} item-warehouse level(s) saved.`); void qc.invalidateQueries({ queryKey: ['reorder'] }); onClose(); },
    onError: (e) => notify('Not saved', e instanceof Error ? e.message : String(e)),
  });
  return (
    <Sheet visible={visible} title="Set reorder levels in bulk" onClose={onClose}>
      <Label>Warehouse</Label>
      <Chips options={['', ...(whs.data ?? []).map((w) => w.id)]} value={wh} onChange={setWh} format={(v) => (v ? whs.data?.find((w) => w.id === v)?.name ?? v : 'All warehouses')} />
      <Label>Company</Label>
      <Chips options={['', ...(tree.data?.brands ?? []).map((b) => b.id)]} value={brand} onChange={setBrand} format={(v) => (v ? tree.data?.brands.find((b) => b.id === v)?.name ?? v : 'All companies')} />
      <Chips options={['SALES', 'FIXED'] as const} value={mode} onChange={setMode} format={(m) => (m === 'SALES' ? 'From sales speed (recommended)' : 'Same number for all')} />
      {mode === 'SALES' ? (
        <>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Field label="Look at sales of the last (days)" value={days} onChangeText={setDays} keyboardType="number-pad" />
            <Field label="Keep enough stock for (days)" value={cover} onChangeText={setCover} keyboardType="number-pad" />
          </View>
          <Label muted>Reorder level = average daily sales × days to keep; order quantity = twice that. Items with no sales are left as they are.</Label>
        </>
      ) : (
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Field label="Reorder when stock is at or below (pcs)" value={min} onChangeText={setMin} keyboardType="number-pad" />
          <Field label="Then order (pcs)" value={qty} onChangeText={setQty} keyboardType="number-pad" />
        </View>
      )}
      <Button title="Set reorder levels" onPress={() => save.mutate()} busy={save.isPending}
        disabled={mode === 'FIXED' ? !(Number(min) >= 0 && min !== '' && Number(qty) >= 0 && qty !== '') : !(Number(days) >= 7 && Number(cover) >= 1)} />
    </Sheet>
  );
}
