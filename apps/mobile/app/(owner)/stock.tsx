/**
 * Owner stock: switch warehouse, pick a company (brand) or see everything,
 * search, correct a stock count (owner only — posted as an audit adjustment so
 * the history is kept), add companies, and export the list to Excel.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Modal, ScrollView, Text, View } from 'react-native';
import { formatBreakdown, formatINR, toBaseQty, type Uom } from '@wh/shared';
import { q, rpc } from '../../src/api/client';
import { Button, Card, Chips, Field, Label, Row, Screen, SmallButton, Toolbar } from '../../src/components/ui';
import { useSelectedWarehouseName, WarehouseSwitch } from '../../src/components/WarehouseSwitch';
import { askText, notify } from '../../src/lib/dialogs';
import { exportXlsx } from '../../src/lib/exportFile';
import { supabase } from '../../src/lib/supabase';
import { fileStamp, useOwnerWarehouse, useWarehouses } from '../../src/lib/warehouse';
import { useTheme } from '../../src/theme';

interface StockItem {
  product_id: string; sku_code: string; name: string; brand_id: string | null; brand: string | null; category: string | null;
  search: string; base_uom_name: string | null; uoms: Uom[]; avg_cost: number | null;
  qty: number; in_transit: number; value: number; per_warehouse: Record<string, number>;
}
interface Brand { id: string; name: string }

const REASONS = ['ADJUST_AUDIT', 'ADJUST_DAMAGE', 'ADJUST_LOSS', 'ADJUST_FOUND', 'OPENING'] as const;
const REASON_LABEL: Record<(typeof REASONS)[number], string> = {
  ADJUST_AUDIT: 'Stock count', ADJUST_DAMAGE: 'Damaged', ADJUST_LOSS: 'Lost / theft', ADJUST_FOUND: 'Found', OPENING: 'Opening stock',
};
const ALL = '__all__';
const ADD = '__add__';

export default function OwnerStock() {
  const t = useTheme();
  const qc = useQueryClient();
  const wh = useOwnerWarehouse((s) => s.id);
  const whName = useSelectedWarehouseName();
  const whs = useWarehouses();
  const [brand, setBrand] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [showZero, setShowZero] = useState(false);
  const [edit, setEdit] = useState<StockItem | null>(null);

  const brands = useQuery({
    queryKey: ['brands'],
    queryFn: () => q<Brand[]>(supabase.from('brands').select('id, name').eq('is_active', true).order('name')),
  });
  const list = useQuery({
    queryKey: ['owner-stock', wh, brand],
    queryFn: () => rpc<StockItem[]>('owner_stock_list', { p_warehouse: wh, p_brand: brand }),
  });

  const addCompany = async () => {
    const name = (await askText('Add company', 'Company / brand name, e.g. "Bosch"'))?.trim();
    if (!name) return;
    const { data, error } = await supabase.from('brands').insert({ name }).select('id').single();
    if (error) return notify('Company not added', error.code === '23505' ? `"${name}" already exists` : error.message);
    await qc.invalidateQueries({ queryKey: ['brands'] });
    void qc.invalidateQueries({ queryKey: ['catalog-tree'] });
    setBrand(data.id);
  };

  const needle = search.trim().toLowerCase();
  const rows = (list.data ?? []).filter((i) => (showZero || Number(i.qty) !== 0)
    && (!needle || `${i.search} ${i.name} ${i.sku_code}`.toLowerCase().includes(needle)));
  const totalValue = rows.reduce((a, i) => a + Number(i.value), 0);
  const codes = (whs.data ?? []).filter((w) => !wh || w.id === wh).map((w) => w.code);
  const brandName = brand ? brands.data?.find((b) => b.id === brand)?.name ?? '' : 'All companies';

  const doExport = () => exportXlsx(`Stock_${whName.replace(/\s+/g, '-')}_${brand ? brandName.replace(/\s+/g, '-') + '_' : ''}${fileStamp()}`, [{
    name: 'Stock',
    columns: [
      { header: 'Item code', width: 16 }, { header: 'Item name', width: 36 }, { header: 'Company', width: 18 },
      { header: 'Category', width: 26 },
      ...(codes.length > 1 ? codes.map((c) => ({ header: `${whs.data?.find((w) => w.code === c)?.name ?? c} qty`, kind: 'number' as const })) : []),
      { header: 'Total qty', kind: 'number' }, { header: 'Unit', width: 8 }, { header: 'In packs', width: 24 },
      { header: 'Avg cost / unit', kind: 'money', width: 16 }, { header: 'Stock value', kind: 'money', width: 16 },
    ],
    rows: rows.map((i) => [
      i.sku_code, i.name, i.brand, i.category,
      ...(codes.length > 1 ? codes.map((c) => Number(i.per_warehouse[c] ?? 0)) : []),
      Number(i.qty), i.base_uom_name, formatBreakdown(Number(i.qty), i.uoms),
      i.avg_cost != null ? Number(i.avg_cost) : null, Number(i.value),
    ]),
  }]).catch((e) => notify('Export failed', e instanceof Error ? e.message : String(e)));

  const brandOptions = [ALL, ...(brands.data ?? []).map((b) => b.id), ADD];

  return (
    <Screen>
      <WarehouseSwitch />
      <Label>Company</Label>
      <Chips options={brandOptions} value={brand ?? ALL}
        onChange={(v) => (v === ADD ? void addCompany() : setBrand(v === ALL ? null : v))}
        format={(v) => (v === ALL ? 'All companies' : v === ADD ? '＋ Add company' : brands.data?.find((b) => b.id === v)?.name ?? '')} />
      <Field label="Search item name, code or local name" value={search} onChangeText={setSearch} autoCapitalize="none" />
      <Toolbar>
        <SmallButton title={showZero ? 'Hide zero stock' : 'Show zero stock too'} onPress={() => setShowZero((v) => !v)} />
        <SmallButton icon="⬇" title="Export to Excel" onPress={doExport} disabled={!rows.length} />
      </Toolbar>

      <Card title={`${whName} · ${brandName}`}>
        <Row left={`${rows.length} item(s)`} right={formatINR(totalValue)} sub="stock value at net purchase cost" />
        {rows.map((i) => (
          <View key={i.product_id} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8, borderBottomWidth: 0.5, borderColor: t.border }}>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={{ color: t.text, fontSize: 15, fontWeight: '600' }}>{i.name}</Text>
              <Text style={{ color: t.textMuted, fontSize: 12 }}>
                {i.sku_code}{i.brand ? ` · ${i.brand}` : ''}{i.category ? ` · ${i.category}` : ''}
              </Text>
              {codes.length > 1 ? (
                <Text style={{ color: t.textSecondary, fontSize: 12 }}>
                  {codes.map((c) => `${whs.data?.find((w) => w.code === c)?.name ?? c}: ${i.per_warehouse[c] ?? 0}`).join(' · ')}
                </Text>
              ) : null}
            </View>
            <View style={{ alignItems: 'flex-end', gap: 2 }}>
              <Text style={{ color: Number(i.qty) > 0 ? t.text : t.danger, fontWeight: '700' }}>{formatBreakdown(Number(i.qty), i.uoms)}</Text>
              <Text style={{ color: t.textMuted, fontSize: 12 }}>{formatINR(Number(i.value))}</Text>
            </View>
            <SmallButton title="Edit" onPress={() => setEdit(i)} />
          </View>
        ))}
        {!rows.length ? <Label muted>{list.isLoading ? 'Loading…' : needle ? 'No item matches your search' : 'No stock here yet'}</Label> : null}
      </Card>

      <EditStock item={edit} onClose={() => setEdit(null)} onSaved={() => {
        setEdit(null);
        for (const k of ['owner-stock', 'stock-overview', 'reorder']) void qc.invalidateQueries({ queryKey: [k] });
      }} />
    </Screen>
  );
}

function EditStock({ item, onClose, onSaved }: { item: StockItem | null; onClose: () => void; onSaved: () => void }) {
  const t = useTheme();
  const whs = useWarehouses();
  const selected = useOwnerWarehouse((s) => s.id);
  const [whId, setWhId] = useState<string | null>(null);
  const [uom, setUom] = useState<string>('');
  const [qty, setQty] = useState('');
  const [reason, setReason] = useState<(typeof REASONS)[number]>('ADJUST_AUDIT');
  const [notes, setNotes] = useState('');

  const warehouseId = whId ?? selected ?? whs.data?.[0]?.id ?? null;
  const wCode = whs.data?.find((w) => w.id === warehouseId)?.code ?? '';
  const uoms = item?.uoms ?? [];
  const unit = uoms.find((u) => u.code === uom) ?? uoms.find((u) => u.factor === 1) ?? uoms[0];

  // current count for the chosen warehouse (fresh from the server)
  const current = useQuery({
    queryKey: ['owner-stock-one', item?.product_id, warehouseId],
    enabled: !!item && !!warehouseId,
    queryFn: async () => {
      const rows = await rpc<StockItem[]>('owner_stock_list', { p_warehouse: warehouseId, p_brand: item!.brand_id });
      return Number(rows.find((r) => r.product_id === item!.product_id)?.per_warehouse[wCode] ?? 0);
    },
  });
  const newBase = qty.trim() === '' ? null : toBaseQty(Number(qty), Number(unit?.factor ?? 1));
  const close = () => { setWhId(null); setUom(''); setQty(''); setNotes(''); setReason('ADJUST_AUDIT'); onClose(); };

  const save = useMutation({
    mutationFn: () => rpc<{ old_qty: number; new_qty: number; delta: number }>('owner_set_stock', {
      p_warehouse: warehouseId, p_product: item!.product_id, p_new_qty_base: newBase, p_reason: reason, p_notes: notes.trim() || null,
    }),
    onSuccess: (r) => {
      notify('Stock updated', `${item?.name}: ${r.old_qty} → ${r.new_qty} (${r.delta >= 0 ? '+' : ''}${r.delta})`);
      setWhId(null); setUom(''); setQty(''); setNotes(''); setReason('ADJUST_AUDIT');
      onSaved();
    },
    onError: (e) => notify('Not saved', e instanceof Error ? e.message : String(e)),
  });

  return (
    <Modal visible={!!item} transparent animationType="fade" onRequestClose={close}>
      <View style={{ flex: 1, backgroundColor: '#0008', justifyContent: 'center', padding: 16 }}>
        <ScrollView style={{ maxHeight: '95%' }} contentContainerStyle={{ backgroundColor: t.surface, padding: 16, gap: 12, borderRadius: 12, width: '100%', maxWidth: 560, alignSelf: 'center' }}>
          <Text style={{ color: t.text, fontSize: 18, fontWeight: '700' }}>Edit stock</Text>
          <Label>{item?.name} · {item?.sku_code}</Label>
          <Label>Warehouse</Label>
          <Chips options={(whs.data ?? []).map((w) => w.id)} value={warehouseId} onChange={setWhId}
            format={(v) => whs.data?.find((w) => w.id === v)?.name ?? v} />
          <Row left="Current stock" right={current.isLoading ? '…' : formatBreakdown(current.data ?? 0, uoms)} />
          {uoms.length > 1 ? (
            <Chips options={uoms.map((u) => u.code)} value={unit?.code ?? null} onChange={setUom} />
          ) : null}
          <Field label={`Correct count (${unit?.displayName ?? unit?.code ?? 'units'})`} keyboardType="decimal-pad" value={qty} onChangeText={setQty} placeholder="e.g. 120" />
          {newBase != null && current.data != null ? (
            <Label muted>
              New stock {formatBreakdown(newBase, uoms)} · change {newBase - current.data >= 0 ? '+' : ''}{Math.round((newBase - current.data) * 1000) / 1000}
            </Label>
          ) : null}
          <Label>Reason</Label>
          <Chips options={REASONS} value={reason} onChange={setReason} format={(r) => REASON_LABEL[r]} />
          <Field label="Note (optional)" value={notes} onChangeText={setNotes} placeholder="e.g. monthly count by Ravi" />
          <Button title="Save stock" onPress={() => save.mutate()} busy={save.isPending}
            disabled={!warehouseId || newBase == null || !(newBase >= 0) || Number.isNaN(newBase)} />
          <Button title="Cancel" kind="secondary" onPress={close} />
        </ScrollView>
      </View>
    </Modal>
  );
}
