/**
 * Owner price tools on the Stock page:
 *   • Import a company price list (Excel / CSV) — new items are added, existing ones get the new price / HSN / GST
 *   • Change prices in bulk by % for a company / category (with a preview)
 *   • Hidden items (show again)
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Platform, Text, View } from 'react-native';
import { formatINR } from '@wh/shared';
import { rpc } from '../api/client';
import { notify } from '../lib/dialogs';
import { pickSpreadsheet, type Book } from '../lib/xlsxRead';
import { useTheme } from '../theme';
import { Sheet } from './Sheet';
import { Button, Card, Chips, Field, Label, Notice, Row, SmallButton } from './ui';

const FIELDS = [
  { key: 'code', label: 'Material No. / item code', match: /material|item ?code|code|sku|part/i, required: true },
  { key: 'name', label: 'Description / name', match: /desc|name|product|item$/i, required: true },
  { key: 'price', label: 'Price (excl. GST)', match: /price|rate|list|dlp|mrp/i, required: true },
  { key: 'gst', label: 'GST %', match: /gst|tax/i, required: false },
  { key: 'hsn', label: 'HSN', match: /hsn/i, required: false },
  { key: 'stdPkg', label: 'Standard pack (pcs)', match: /std|pack|pkg/i, required: false },
  { key: 'moq', label: 'MOQ (pcs)', match: /moq|min/i, required: false },
] as const;
type Key = (typeof FIELDS)[number]['key'];
const num = (s: string) => { const v = Number(String(s).replace(/[₹,\s%]/g, '')); return Number.isFinite(v) ? v : null; };

export function PriceListImport({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const t = useTheme();
  const qc = useQueryClient();
  const [file, setFile] = useState<{ name: string; book: Book } | null>(null);
  const [sheet, setSheet] = useState(0);
  const [headerRow, setHeaderRow] = useState(0);
  const [map, setMap] = useState<Partial<Record<Key, number>>>({});
  const [brand, setBrand] = useState('');
  const [gstDefault, setGstDefault] = useState('18');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ added: number; updated: number; skipped: number } | null>(null);
  useEffect(() => { if (!visible) { setFile(null); setResult(null); } }, [visible]);

  const rows = file?.book.sheets[sheet]?.rows ?? [];
  // header = first row (within the first 15) that has a code-like and a price-like column
  useEffect(() => {
    if (!rows.length) return;
    const h = rows.slice(0, 15).findIndex((r) => r.some((c) => /material|code/i.test(c)) && r.some((c) => /price|rate|list/i.test(c)));
    const hr = h >= 0 ? h : 0;
    setHeaderRow(hr);
    const head = rows[hr] ?? [];
    const m: Partial<Record<Key, number>> = {};
    for (const f of FIELDS) { const i = head.findIndex((c, j) => f.match.test(c) && !Object.values(m).includes(j)); if (i >= 0) m[f.key] = i; }
    setMap(m);
    if (!brand) setBrand(file?.book.sheets[sheet]?.name.replace(/^sheet\d*$/i, '') ?? '');
  }, [file, sheet]); // eslint-disable-line react-hooks/exhaustive-deps

  const head = rows[headerRow] ?? [];
  const data = useMemo(() => rows.slice(headerRow + 1).map((r) => ({
    code: map.code != null ? r[map.code] ?? '' : '', name: map.name != null ? r[map.name] ?? '' : '',
    price: map.price != null ? num(r[map.price] ?? '') : null,
    gst: map.gst != null ? num(r[map.gst] ?? '') ?? num(gstDefault) : num(gstDefault),
    hsn: map.hsn != null ? (r[map.hsn] ?? '').replace(/\D/g, '') : '',
    stdPkg: map.stdPkg != null ? num(r[map.stdPkg] ?? '') : null, moq: map.moq != null ? num(r[map.moq] ?? '') : null,
  })).filter((x) => x.code.trim() && x.name.trim() && x.price != null)
    .map((x) => ({ ...x, gst: x.gst != null && x.gst > 0 && x.gst < 1 ? Math.round(x.gst * 100) : x.gst })), [rows, headerRow, map, gstDefault]);

  const run = async () => {
    setBusy(true);
    const total = { added: 0, updated: 0, skipped: 0 };
    try {
      for (let i = 0; i < data.length; i += 300) {
        const r = await rpc<{ added: number; updated: number; skipped: unknown[] }>('owner_import_catalog', { p_brand: brand.trim(), p_list: file?.name ?? 'import', p_rows: data.slice(i, i + 300) });
        total.added += Number(r.added ?? 0); total.updated += Number(r.updated ?? 0); total.skipped += (r.skipped ?? []).length;
      }
      setResult(total);
      for (const k of ['owner-stock', 'catalog-tree', 'brands', 'search']) void qc.invalidateQueries({ queryKey: [k] });
    } catch (e) { notify('Import stopped', e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };

  return (
    <Sheet visible={visible} title="Import a price list" subtitle="Excel (.xlsx) or CSV from the company" onClose={onClose} wide>
      {Platform.OS !== 'web' ? <Notice tone="warning">Open the app in the browser or home-screen app to pick a file.</Notice> : null}
      <Button title={file ? `File: ${file.name} — pick another` : 'Choose the price list file'} icon="document-attach-outline" kind="secondary"
        onPress={() => void pickSpreadsheet().then((f) => { if (f) { setFile(f); setSheet(0); setResult(null); } else notify('Could not read that file', 'Save it as .xlsx or .csv and try again.'); })} />
      {file ? (
        <>
          {file.book.sheets.length > 1 ? <><Label>Sheet</Label><Chips options={file.book.sheets.map((_, i) => i)} value={sheet} onChange={setSheet} format={(i) => file.book.sheets[i]!.name} /></> : null}
          <Field label="Company name (items are filed under it)" value={brand} onChangeText={setBrand} placeholder="e.g. Tata Agrico" />
          <Card title="Which column is which?" subtitle={`Header found on row ${headerRow + 1}. Change any that are wrong.`}>
            {FIELDS.map((f) => (
              <View key={f.key} style={{ gap: 4 }}>
                <Label>{f.label}{f.required ? ' *' : ''}</Label>
                <Chips options={[-1, ...head.map((_, i) => i)]} value={map[f.key] ?? -1}
                  onChange={(v) => setMap((m) => ({ ...m, [f.key]: v < 0 ? undefined : v }))} format={(i) => (i < 0 ? '— none —' : head[i] || `Column ${i + 1}`)} />
              </View>
            ))}
            {map.gst == null ? <Field label="GST % for every item (no GST column)" value={gstDefault} onChangeText={setGstDefault} keyboardType="decimal-pad" /> : null}
          </Card>
          <Card title={`${data.length} item(s) ready`} subtitle="First 5 shown">
            {data.slice(0, 5).map((x, i) => <Row key={i} left={`${x.code} · ${x.name}`} sub={`GST ${x.gst ?? '?'}%${x.hsn ? ` · HSN ${x.hsn}` : ''}${x.stdPkg ? ` · pack ${x.stdPkg}` : ''}`} right={formatINR(Number(x.price))} />)}
          </Card>
          {result ? (
            <Notice tone="good">{`Done: ${result.added} new item(s), ${result.updated} price(s) updated${result.skipped ? `, ${result.skipped} row(s) skipped (bad code, GST rate or price)` : ''}.`}</Notice>
          ) : (
            <Button title={`Import ${data.length} item(s)`} icon="cloud-upload-outline" onPress={() => void run()} busy={busy}
              disabled={!data.length || brand.trim().length < 2 || map.code == null || map.name == null || map.price == null} />
          )}
          <Text style={{ color: t.textMuted, fontSize: 12 }}>Existing items (same code) get the new price, HSN and GST; their stock is not touched.</Text>
        </>
      ) : null}
    </Sheet>
  );
}

export function BulkPrice({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const tree = useQuery({ queryKey: ['catalog-tree'], staleTime: 600_000, queryFn: () => rpc<{ brands: { id: string; name: string }[]; categories: { id: string; path: string }[] }>('catalog_tree') });
  const [brand, setBrand] = useState(''); const [cat, setCat] = useState('');
  const [pct, setPct] = useState(''); const [round, setRound] = useState(1);
  const [preview, setPreview] = useState<{ items: number; sample: { sku_code: string; name: string; old: number; new: number }[] } | null>(null);
  useEffect(() => setPreview(null), [brand, cat, pct, round]);
  const body = { brandId: brand || null, categoryId: cat || null, pct: Number(pct), roundTo: round };
  const look = useMutation({ mutationFn: () => rpc<typeof preview>('owner_bulk_price', { p: { ...body, preview: true } }), onSuccess: setPreview,
    onError: (e) => notify('Check the numbers', e instanceof Error ? e.message : String(e)) });
  const apply = useMutation({ mutationFn: () => rpc<{ items: number }>('owner_bulk_price', { p: body }),
    onSuccess: (r) => { notify('Prices changed', `${r.items} item(s) updated.`); for (const k of ['owner-stock', 'search', 'owner-product']) void qc.invalidateQueries({ queryKey: [k] }); onClose(); },
    onError: (e) => notify('Not changed', e instanceof Error ? e.message : String(e)) });
  return (
    <Sheet visible={visible} title="Change prices in bulk" subtitle="Selling (list) price, excl. GST" onClose={onClose}>
      <Label>Company</Label>
      <Chips options={['', ...(tree.data?.brands ?? []).map((b) => b.id)]} value={brand} onChange={setBrand} format={(v) => (v ? tree.data?.brands.find((b) => b.id === v)?.name ?? v : 'All companies')} />
      <Label>Category (optional)</Label>
      <Chips options={['', ...(tree.data?.categories ?? []).map((c) => c.id)]} value={cat} onChange={setCat} format={(v) => (v ? tree.data?.categories.find((c) => c.id === v)?.path ?? v : 'All categories')} />
      <Field label="Change by % (e.g. 5 to raise, -3 to lower)" value={pct} onChangeText={setPct} keyboardType="numbers-and-punctuation" />
      <Label>Round new prices to</Label>
      <Chips options={[0.01, 1, 5, 10]} value={round} onChange={setRound} format={(v) => (v === 0.01 ? 'paise' : `₹${v}`)} />
      <Button title="Preview" kind="secondary" onPress={() => look.mutate()} busy={look.isPending} disabled={!Number(pct)} />
      {preview ? (
        <Card title={`${preview.items} item(s) will change`}>
          {preview.sample.map((x) => <Row key={x.sku_code} left={`${x.sku_code} · ${x.name}`} right={`${formatINR(Number(x.old))} → ${formatINR(Number(x.new))}`} />)}
          <Button title={`Apply to ${preview.items} item(s)`} onPress={() => apply.mutate()} busy={apply.isPending} disabled={!preview.items} />
        </Card>
      ) : null}
    </Sheet>
  );
}

export function HiddenItems({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['hidden-items'], enabled: visible, queryFn: () => rpc<{ id: string; sku_code: string; name: string; brand: string | null }[]>('owner_hidden_items') });
  const show = (id: string) => rpc('owner_set_item_active', { p_product: id, p_active: true })
    .then(() => { void qc.invalidateQueries({ queryKey: ['hidden-items'] }); void qc.invalidateQueries({ queryKey: ['owner-stock'] }); }, (e) => notify('Not done', String(e)));
  return (
    <Sheet visible={visible} title="Hidden items" subtitle="Not shown when billing or searching" onClose={onClose}>
      {(q.data ?? []).map((i) => <Row key={i.id} left={i.name} sub={`${i.sku_code}${i.brand ? ` · ${i.brand}` : ''}`} right={<SmallButton title="Show again" onPress={() => void show(i.id)} />} />)}
      {!q.data?.length ? <Label muted>{q.isLoading ? 'Loading…' : 'No hidden items'}</Label> : null}
    </Sheet>
  );
}
