/**
 * Owner stock: switch warehouse, pick a company (brand) or see everything,
 * search, add / edit items (name, code, HSN, GST, MRP ⇄ price before GST),
 * correct stock counts, see who entered stock, manage companies, export to Excel.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { formatBreakdown, formatINR, type Uom } from '@wh/shared';
import { q, rpc } from '../../src/api/client';
import { CompanyEditor } from '../../src/components/CompanyEditor';
import { ItemEditor } from '../../src/components/ItemEditor';
import { BulkPrice, HiddenItems, PriceListImport } from '../../src/components/PriceTools';
import { useAuth } from '../../src/auth/store';
import { Card, Chips, Field, Label, Row, Screen, SmallButton, Toolbar } from '../../src/components/ui';
import { useSelectedWarehouseName, WarehouseSwitch } from '../../src/components/WarehouseSwitch';
import { askText, notify } from '../../src/lib/dialogs';
import { exportXlsx } from '../../src/lib/exportFile';
import { supabase } from '../../src/lib/supabase';
import { dateTimeIST } from '../../src/lib/dates';
import { fileStamp, useOwnerWarehouse, useWarehouses } from '../../src/lib/warehouse';
import { useTheme } from '../../src/theme';

interface StockItem {
  product_id: string; sku_code: string; name: string; brand_id: string | null; brand: string | null; category: string | null;
  search: string; base_uom_name: string | null; uoms: Uom[]; avg_cost: number | null;
  qty: number; in_transit: number; value: number; value_basis?: 'COST' | 'LIST' | 'NONE'; per_warehouse: Record<string, number>;
  hsn_code: string | null; gst_rate: number; mrp: number | null; selling_price: number | null;
  last_entry: { by: string; at: string; movement: string; qty: number } | null;
}
interface Brand { id: string; name: string }

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
  const [edit, setEdit] = useState<string | null>(null);     // product id, or 'new'
  const [companies, setCompanies] = useState(false);
  const [tool, setTool] = useState<'import' | 'bulk' | 'hidden' | null>(null);
  const fullOwner = useAuth((s) => s.user?.role) === 'OWNER';

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
      { header: 'Avg cost / unit', kind: 'money', width: 16 }, { header: 'Stock value', kind: 'money', width: 16 }, { header: 'Valued at', width: 12 },
      { header: 'HSN', width: 10 }, { header: 'GST %', kind: 'number', width: 7 },
      { header: 'Price before GST', kind: 'money', width: 16 }, { header: 'MRP incl. GST', kind: 'money', width: 14 },
      { header: 'Last stock entry by', width: 22 }, { header: 'Last entry at', width: 20 },
    ],
    rows: rows.map((i) => [
      i.sku_code, i.name, i.brand, i.category,
      ...(codes.length > 1 ? codes.map((c) => Number(i.per_warehouse[c] ?? 0)) : []),
      Number(i.qty), i.base_uom_name, formatBreakdown(Number(i.qty), i.uoms),
      i.avg_cost != null ? Number(i.avg_cost) : null, Number(i.value), i.value_basis === 'LIST' ? 'List price' : i.value_basis === 'NONE' ? 'No price' : 'Cost',
      i.hsn_code, Number(i.gst_rate), i.selling_price != null ? Number(i.selling_price) : null, i.mrp != null ? Number(i.mrp) : null,
      i.last_entry?.by ?? null, i.last_entry ? dateTimeIST(i.last_entry.at) : null,
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
        <SmallButton title="＋ Add item" kind="primary" onPress={() => setEdit('new')} />
        <SmallButton title="✎ Edit companies" onPress={() => setCompanies(true)} />
        <SmallButton title={showZero ? 'Hide zero stock' : 'Show zero stock too'} onPress={() => setShowZero((v) => !v)} />
        <SmallButton icon="⬇" title="Export to Excel" onPress={doExport} disabled={!rows.length} />
        {fullOwner ? <SmallButton icon="cloud-upload-outline" title="Import price list" onPress={() => setTool('import')} /> : null}
        {fullOwner ? <SmallButton icon="trending-up-outline" title="Change prices by %" onPress={() => setTool('bulk')} /> : null}
        <SmallButton icon="eye-off-outline" title="Hidden items" onPress={() => setTool('hidden')} />
      </Toolbar>

      <Card title={`${whName} · ${brandName}`} subtitle="Quantity on hand, cost and value per item — tap an item to edit it">
        <Row left={`${rows.length} item(s)`} right={formatINR(totalValue)}
          sub={`stock value at net purchase cost${rows.some((i) => i.value_basis === 'LIST' && Number(i.qty) > 0) ? '; items never purchased are valued at list price (marked “list”)' : ''}`} />
        {rows.map((i) => (
          <Pressable key={i.product_id} onPress={() => setEdit(i.product_id)}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8, borderBottomWidth: 0.5, borderColor: t.border }}>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={{ color: t.text, fontSize: 15, fontWeight: '600' }}>{i.name}</Text>
              <Text style={{ color: t.textMuted, fontSize: 12 }}>
                {i.sku_code}{i.brand ? ` · ${i.brand}` : ''}{i.hsn_code ? ` · HSN ${i.hsn_code}` : ''} · GST {Number(i.gst_rate)}%
                {i.mrp != null ? ` · MRP ${formatINR(Number(i.mrp))}` : ''}
              </Text>
              {codes.length > 1 ? (
                <Text style={{ color: t.textSecondary, fontSize: 12 }}>
                  {codes.map((c) => `${whs.data?.find((w) => w.code === c)?.name ?? c}: ${i.per_warehouse[c] ?? 0}`).join(' · ')}
                </Text>
              ) : null}
              {i.last_entry ? (
                <Text style={{ color: t.textMuted, fontSize: 11 }}>Last entry by {i.last_entry.by} · {dateTimeIST(i.last_entry.at)}</Text>
              ) : null}
            </View>
            <View style={{ alignItems: 'flex-end', gap: 2 }}>
              <Text style={{ color: Number(i.qty) > 0 ? t.text : t.danger, fontWeight: '700' }}>{formatBreakdown(Number(i.qty), i.uoms)}</Text>
              <Text style={{ color: t.textMuted, fontSize: 12 }}>{formatINR(Number(i.value))}{i.value_basis === 'LIST' && Number(i.qty) > 0 ? ' · list' : i.value_basis === 'NONE' && Number(i.qty) > 0 ? ' · no price' : ''}</Text>
            </View>
            <SmallButton title="Edit" onPress={() => setEdit(i.product_id)} />
          </Pressable>
        ))}
        {!rows.length ? <Label muted>{list.isLoading ? 'Loading…' : needle ? 'No item matches your search' : 'No stock here yet'}</Label> : null}
      </Card>

      <ItemEditor productId={edit === 'new' ? null : edit} visible={!!edit} onClose={() => setEdit(null)} defaultBrandId={brand} />
      <PriceListImport visible={tool === 'import'} onClose={() => setTool(null)} />
      <BulkPrice visible={tool === 'bulk'} onClose={() => setTool(null)} />
      <HiddenItems visible={tool === 'hidden'} onClose={() => setTool(null)} />
      <CompanyEditor visible={companies} onClose={() => setCompanies(false)} />
    </Screen>
  );
}
