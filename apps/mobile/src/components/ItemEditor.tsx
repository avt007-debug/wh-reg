/**
 * Owner: add a new item or edit one — name, code, company, HSN, GST, MRP ⇄
 * price before GST (either one fills the other), packs, reorder level — plus
 * stock correction per warehouse and the stock history showing who entered
 * every change.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Modal, ScrollView, Text, View } from 'react-native';
import { formatBreakdown, fromBase, fromInclusive, toBaseQty, type Uom, type UnitPrice } from '@wh/shared';
import { q, rpc } from '../api/client';
import { dateTimeIST } from '../lib/dates';
import { notify } from '../lib/dialogs';
import { supabase } from '../lib/supabase';
import { useOwnerWarehouse, useWarehouses } from '../lib/warehouse';
import { useTheme } from '../theme';
import { ItemExtras } from './ItemExtras';
import { PriceGstField } from './PriceGstField';
import { Button, Card, Chips, Field, Label, Row, SmallButton, pageBg } from './ui';

interface Product {
  id: string; sku_code: string; name: string; brand_id: string | null; category_id: string | null; specification: string | null;
  hsn_code: string | null; gst_rate: number; base_uom: string; mrp: number | null; selling_price: number | null;
  reorder_level: number; packs: { code: string; factor: number; name: string }[]; is_active?: boolean;
}
interface History { at: string; movement: string; qty: number; warehouse: string; entered_by: string; entered_by_role: string; posted_by: string; reference: string }
interface Pack { code: string; factor: string }

const BASE_UNITS = ['PCS', 'SET', 'PAIR', 'MTR', 'KG', 'LTR', 'ROLL', 'BOX'] as const;
const REASONS = ['ADJUST_AUDIT', 'ADJUST_DAMAGE', 'ADJUST_LOSS', 'ADJUST_FOUND', 'OPENING'] as const;
const REASON_LABEL: Record<(typeof REASONS)[number], string> = {
  ADJUST_AUDIT: 'Stock count', ADJUST_DAMAGE: 'Damaged', ADJUST_LOSS: 'Lost / theft', ADJUST_FOUND: 'Found', OPENING: 'Opening stock',
};
const MOVE_LABEL: Record<string, string> = {
  PURCHASE_IN: 'Purchase in', DISPATCH_OUT: 'Sale out', TRANSFER_OUT: 'Transfer out', TRANSFER_IN: 'Transfer in',
  ADJUST_AUDIT: 'Stock count', ADJUST_DAMAGE: 'Damaged', ADJUST_LOSS: 'Lost', ADJUST_FOUND: 'Found', OPENING: 'Opening stock', REVERSAL: 'Reversed',
  SALES_RETURN: 'Returned by customer', PURCHASE_RETURN: 'Returned to supplier',
};
const n = (x: unknown) => Number(x ?? 0);

export function ItemEditor({ productId, visible, onClose, defaultBrandId }: {
  /** null = add a new item */
  productId: string | null; visible: boolean; onClose: () => void; defaultBrandId?: string | null;
}) {
  const t = useTheme();
  const qc = useQueryClient();
  const whs = useWarehouses();
  const isNew = !productId;
  const [tab, setTab] = useState<'Details' | 'Stock' | 'History' | 'Photos & more'>('Details');

  const prod = useQuery({ queryKey: ['owner-product', productId], enabled: visible && !!productId, queryFn: () => rpc<Product>('owner_product', { p_id: productId }) });
  const brands = useQuery({ queryKey: ['brands'], queryFn: () => q<{ id: string; name: string }[]>(supabase.from('brands').select('id, name').eq('is_active', true).order('name')) });
  const tree = useQuery({ queryKey: ['catalog-tree'], staleTime: 600_000, queryFn: () => rpc<{ categories: { id: string; path: string }[] }>('catalog_tree') });
  const slabs = useQuery({ queryKey: ['gst'], staleTime: 3600_000, queryFn: () => q<{ rate: number }[]>(supabase.from('gst_rates').select('rate').eq('is_active', true).order('rate')) });

  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [brandId, setBrandId] = useState<string | null>(null);
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [spec, setSpec] = useState('');
  const [hsn, setHsn] = useState('');
  const [gst, setGst] = useState(18);
  const [price, setPrice] = useState<UnitPrice | null>(null);
  const [baseUom, setBaseUom] = useState('PCS');
  const [packs, setPacks] = useState<Pack[]>([]);
  const [reorder, setReorder] = useState('');
  const [opening, setOpening] = useState<Record<string, string>>({});
  const [loadedFor, setLoadedFor] = useState<string | null>(null);

  // fill the form when opened
  useEffect(() => {
    if (!visible) return;
    setTab('Details');
    if (isNew) {
      setName(''); setCode(''); setBrandId(defaultBrandId ?? null); setCategoryId(null); setSpec(''); setHsn(''); setGst(18);
      setPrice(null); setBaseUom('PCS'); setPacks([]); setReorder(''); setOpening({}); setLoadedFor('new');
    } else if (prod.data && loadedFor !== prod.data.id) {
      const p = prod.data;
      setName(p.name); setCode(p.sku_code); setBrandId(p.brand_id); setCategoryId(p.category_id); setSpec(p.specification ?? '');
      setHsn(p.hsn_code ?? ''); setGst(n(p.gst_rate)); setBaseUom(p.base_uom); setReorder(String(n(p.reorder_level)));
      setPrice(p.selling_price != null ? fromBase(n(p.selling_price), n(p.gst_rate))
        : p.mrp != null ? fromInclusive(n(p.mrp), n(p.gst_rate)) : null);
      setPacks(p.packs.map((x) => ({ code: x.code, factor: String(n(x.factor)) })));
      setLoadedFor(p.id);
    }
  }, [visible, isNew, prod.data, defaultBrandId, loadedFor]);

  const close = () => { setLoadedFor(null); onClose(); };
  const ready = isNew ? loadedFor === 'new' : loadedFor === productId;

  const codeOk = /^[A-Z0-9][A-Z0-9_./-]{1,31}$/.test(code.trim().toUpperCase());
  const hsnOk = !hsn.trim() || /^[0-9]{4}([0-9]{2}){0,2}$/.test(hsn.trim());
  const packsOk = packs.every((p) => !p.code.trim() || (/^[A-Z]{2,6}$/.test(p.code.trim().toUpperCase()) && Number(p.factor) > 1));

  const save = useMutation({
    mutationFn: () => rpc<{ id: string }>('owner_save_product', {
      p: {
        id: productId, skuCode: code.trim().toUpperCase(), name: name.trim(), brandId, categoryId, specification: spec,
        hsnCode: hsn.trim(), gstRate: gst, mrp: price ? price.inclusive : null, sellingPrice: price ? price.base : null,
        reorderLevel: reorder === '' ? 0 : Number(reorder), baseUom,
        packs: packs.filter((p) => p.code.trim()).map((p) => ({ code: p.code.trim().toUpperCase(), factor: Number(p.factor) })),
        openingStock: isNew ? Object.entries(opening).filter(([, v]) => Number(v) > 0).map(([warehouseId, v]) => ({ warehouseId, qty: Number(v) })) : [],
      },
    }),
    onSuccess: () => {
      for (const k of ['owner-stock', 'owner-product', 'stock-overview', 'reorder', 'catalog-tree', 'search']) void qc.invalidateQueries({ queryKey: [k] });
      notify(isNew ? 'Item added' : 'Item saved');
      close();
    },
    onError: (e) => notify('Not saved', e instanceof Error ? e.message : String(e)),
  });

  const brandOpts = ['', ...(brands.data ?? []).map((b) => b.id)];
  const cats = tree.data?.categories ?? [];

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={close}>
      <ScrollView style={[{ flex: 1 }, pageBg(t)]} keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ padding: 16, gap: 12, paddingTop: 40, width: '100%', maxWidth: 760, alignSelf: 'center' }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text style={{ flex: 1, color: t.text, fontSize: 20, fontWeight: '700' }}>{isNew ? 'Add item' : `Edit · ${prod.data?.name ?? ''}`}</Text>
          <SmallButton title="Close" onPress={close} />
        </View>
        {!isNew ? <Chips options={['Details', 'Stock', 'History', 'Photos & more'] as const} value={tab} onChange={setTab}
          format={(v) => (v === 'History' ? 'Who entered stock' : v === 'Stock' ? 'Correct stock' : 'Item details')} /> : null}

        {!ready ? <Label muted>Loading…</Label> : tab === 'Details' ? (
          <>
            <Card title="Item">
              <Field label="Item name" value={name} onChangeText={setName} placeholder="e.g. Claw Hammer 500g" />
              <Field label="Item code" value={code} autoCapitalize="characters" onChangeText={(v) => setCode(v.toUpperCase())}
                placeholder="e.g. TAP-HM-500" error={code && !codeOk ? '2–32 letters, digits or - _ . /' : undefined} />
              <Label>Company</Label>
              <Chips options={brandOpts} value={brandId ?? ''} onChange={(v) => setBrandId(v || null)}
                format={(v) => (v ? brands.data?.find((b) => b.id === v)?.name ?? '' : 'None')} />
              {cats.length ? (
                <>
                  <Label>Category</Label>
                  <Chips options={['', ...cats.map((c) => c.id)]} value={categoryId ?? ''} onChange={(v) => setCategoryId(v || null)}
                    format={(v) => (v ? cats.find((c) => c.id === v)?.path ?? '' : 'None')} />
                </>
              ) : null}
              <Field label="Size / specification (optional)" value={spec} onChangeText={setSpec} placeholder="e.g. 13mm, 600W" />
            </Card>

            <Card title="Tax & price">
              <Field label="HSN code" value={hsn} keyboardType="number-pad" maxLength={8} onChangeText={(v) => setHsn(v.replace(/\D/g, ''))}
                placeholder="4, 6 or 8 digits" error={!hsnOk ? 'HSN must be 4, 6 or 8 digits' : undefined} />
              <PriceGstField key={`${loadedFor}`} gstRate={gst} slabs={(slabs.data ?? []).map((s) => n(s.rate))}
                onRateChange={setGst} value={price} onChange={setPrice} unitLabel={baseUom}
                baseLabel={`Price before GST / ${baseUom}`} inclLabel={`MRP incl. GST / ${baseUom}`} />
              <Label muted>Type either price — the other is worked out from the GST rate.</Label>
            </Card>

            <Card title="Units & reorder">
              {isNew ? (
                <>
                  <Label>Counted in</Label>
                  <Chips options={BASE_UNITS} value={baseUom} onChange={setBaseUom} />
                </>
              ) : <Row left="Counted in" right={baseUom} />}
              <Label>Packs (optional) — e.g. BOX of 10, CTN of 100 {baseUom}</Label>
              {packs.map((p, i) => (
                <View key={i} style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-end' }}>
                  <Field label="Pack" value={p.code} autoCapitalize="characters" maxLength={6}
                    onChangeText={(v) => setPacks((ps) => ps.map((x, j) => (j === i ? { ...x, code: v.toUpperCase().replace(/[^A-Z]/g, '') } : x)))} placeholder="BOX" />
                  <Field label={`${baseUom} in one pack`} value={p.factor} keyboardType="number-pad"
                    onChangeText={(v) => setPacks((ps) => ps.map((x, j) => (j === i ? { ...x, factor: v } : x)))} placeholder="10" />
                  <SmallButton title="✕" kind="danger" onPress={() => setPacks((ps) => ps.filter((_, j) => j !== i))} />
                </View>
              ))}
              <SmallButton title="＋ Add pack size" onPress={() => setPacks((ps) => [...ps, { code: '', factor: '' }])} />
              <Field label={`Reorder when stock falls to (${baseUom})`} value={reorder} keyboardType="number-pad" onChangeText={setReorder} placeholder="0" />
            </Card>

            {isNew ? (
              <Card title="Opening stock (optional)">
                {(whs.data ?? []).map((w) => (
                  <Field key={w.id} label={`${w.name} (${baseUom})`} value={opening[w.id] ?? ''} keyboardType="decimal-pad"
                    onChangeText={(v) => setOpening((o) => ({ ...o, [w.id]: v }))} placeholder="0" />
                ))}
              </Card>
            ) : null}

            <Button title={isNew ? 'Add item' : 'Save item'} onPress={() => save.mutate()} busy={save.isPending}
              disabled={!name.trim() || !codeOk || !hsnOk || !packsOk} />
          </>
        ) : tab === 'Stock' && productId ? (
          <StockCorrection productId={productId} />
        ) : tab === 'Photos & more' && productId ? (
          <ItemExtras productId={productId} active={prod.data?.is_active !== false} name={prod.data?.name ?? ''} onClose={onClose} />
        ) : productId ? (
          <StockHistory productId={productId} />
        ) : null}
      </ScrollView>
    </Modal>
  );
}

function StockCorrection({ productId }: { productId: string }) {
  const qc = useQueryClient();
  const whs = useWarehouses();
  const selected = useOwnerWarehouse((s) => s.id);
  const [whId, setWhId] = useState<string | null>(null);
  const [uom, setUom] = useState('');
  const [qty, setQty] = useState('');
  const [reason, setReason] = useState<(typeof REASONS)[number]>('ADJUST_AUDIT');
  const [notes, setNotes] = useState('');
  const warehouseId = whId ?? selected ?? whs.data?.[0]?.id ?? null;
  const wCode = whs.data?.find((w) => w.id === warehouseId)?.code ?? '';

  const row = useQuery({
    queryKey: ['owner-stock-one', productId, warehouseId],
    enabled: !!warehouseId,
    queryFn: async () => (await rpc<{ product_id: string; uoms: Uom[]; per_warehouse: Record<string, number> }[]>('owner_stock_list', { p_warehouse: warehouseId }))
      .find((r) => r.product_id === productId),
  });
  const uoms = row.data?.uoms ?? [];
  const current = n(row.data?.per_warehouse[wCode]);
  const unit = uoms.find((u) => u.code === uom) ?? uoms.find((u) => u.factor === 1) ?? uoms[0];
  const newBase = qty.trim() === '' ? null : toBaseQty(Number(qty), n(unit?.factor ?? 1));

  const save = useMutation({
    mutationFn: () => rpc<{ old_qty: number; new_qty: number; delta: number }>('owner_set_stock', {
      p_warehouse: warehouseId, p_product: productId, p_new_qty_base: newBase, p_reason: reason, p_notes: notes.trim() || null,
    }),
    onSuccess: (r) => {
      notify('Stock updated', `${r.old_qty} → ${r.new_qty} (${r.delta >= 0 ? '+' : ''}${r.delta})`);
      setQty(''); setNotes('');
      for (const k of ['owner-stock', 'owner-stock-one', 'stock-history', 'stock-overview', 'reorder']) void qc.invalidateQueries({ queryKey: [k] });
    },
    onError: (e) => notify('Not saved', e instanceof Error ? e.message : String(e)),
  });

  return (
    <Card title="Correct the stock count">
      <Label>Warehouse</Label>
      <Chips options={(whs.data ?? []).map((w) => w.id)} value={warehouseId} onChange={setWhId} format={(v) => whs.data?.find((w) => w.id === v)?.name ?? v} />
      <Row left="Current stock" right={row.isLoading ? '…' : formatBreakdown(current, uoms)} />
      {uoms.length > 1 ? <Chips options={uoms.map((u) => u.code)} value={unit?.code ?? null} onChange={setUom} /> : null}
      <Field label={`Correct count (${unit?.displayName ?? unit?.code ?? 'units'})`} keyboardType="decimal-pad" value={qty} onChangeText={setQty} placeholder="e.g. 120" />
      {newBase != null && Number.isFinite(newBase) ? (
        <Label muted>New stock {formatBreakdown(newBase, uoms)} · change {newBase - current >= 0 ? '+' : ''}{Math.round((newBase - current) * 1000) / 1000}</Label>
      ) : null}
      <Label>Reason</Label>
      <Chips options={REASONS} value={reason} onChange={setReason} format={(r) => REASON_LABEL[r]} />
      <Field label="Note (optional)" value={notes} onChangeText={setNotes} placeholder="e.g. monthly count" />
      <Button title="Save stock" onPress={() => save.mutate()} busy={save.isPending}
        disabled={!warehouseId || newBase == null || !(newBase >= 0) || Number.isNaN(newBase)} />
    </Card>
  );
}

function StockHistory({ productId }: { productId: string }) {
  const t = useTheme();
  const wh = useOwnerWarehouse((s) => s.id);
  const h = useQuery({ queryKey: ['stock-history', productId, wh], queryFn: () => rpc<History[]>('owner_stock_history', { p_product: productId, p_warehouse: wh, p_limit: 100 }) });
  return (
    <Card title="Who entered the stock">
      {(h.data ?? []).map((r, i) => (
        <View key={i} style={{ flexDirection: 'row', gap: 8, paddingVertical: 8, borderBottomWidth: 0.5, borderColor: t.border }}>
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={{ color: t.text, fontWeight: '600' }}>{MOVE_LABEL[r.movement] ?? r.movement} · {r.warehouse}</Text>
            <Text style={{ color: t.textSecondary, fontSize: 13 }}>
              Entered by {r.entered_by}{r.posted_by !== r.entered_by ? ` · approved by ${r.posted_by}` : ''}
            </Text>
            <Text style={{ color: t.textMuted, fontSize: 12 }}>{dateTimeIST(r.at)}{r.reference ? ` · ${r.reference}` : ''}</Text>
          </View>
          <Text style={{ color: n(r.qty) >= 0 ? t.good : t.danger, fontWeight: '700', fontVariant: ['tabular-nums'] }}>
            {n(r.qty) >= 0 ? '+' : ''}{n(r.qty)}
          </Text>
        </View>
      ))}
      {!h.data?.length ? <Label muted>{h.isLoading ? 'Loading…' : 'No stock movements yet'}</Label> : null}
    </Card>
  );
}

