import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { formatINR } from '@wh/shared';
import { rpc } from '../../src/api/client';
import { Button, Card, Field, Label, Screen, SmallButton, Toolbar } from '../../src/components/ui';
import { BulkReorder } from '../../src/components/BulkReorder';
import { useSelectedWarehouseName, WarehouseSwitch } from '../../src/components/WarehouseSwitch';
import { notify } from '../../src/lib/dialogs';
import { exportXlsx } from '../../src/lib/exportFile';
import { fileStamp, useOwnerWarehouse, useWarehouses } from '../../src/lib/warehouse';
import { useTheme } from '../../src/theme';

interface Alert_ {
  warehouse_id: string; warehouse_code: string; product_id: string; sku_code: string; name: string;
  qty_on_hand: number; qty_in_transit: number; threshold: number; suggested_qty_base: number;
  last_vendor_name: string | null; last_purchase_date: string | null;
  last_billed_cost_base: number | null; last_effective_cost_base: number | null;
}

/** Current Stock ≤ Minimum Reorder Threshold, with last price & vendor; select → one-click PO; export to Excel. */
export default function Reorder() {
  const [bulk, setBulk] = useState(false);
  const t = useTheme();
  const qc = useQueryClient();
  const wh = useOwnerWarehouse((s) => s.id);
  const whName = useSelectedWarehouseName();
  const whs = useWarehouses();
  const nameOf = (id: string, code: string) => whs.data?.find((w) => w.id === id)?.name ?? code;
  const q = useQuery({ queryKey: ['reorder'], queryFn: () => rpc<Alert_[]>('owner_reorder_alerts') });
  const [sel, setSel] = useState<Record<string, boolean>>({});
  const [search, setSearch] = useState('');
  const key = (a: Alert_) => `${a.warehouse_id}:${a.product_id}`;

  const needle = search.trim().toLowerCase();
  const rows = (q.data ?? []).filter((a) => (!wh || a.warehouse_id === wh)
    && (!needle || `${a.name} ${a.sku_code} ${a.last_vendor_name ?? ''}`.toLowerCase().includes(needle)));
  const chosen = rows.filter((a) => sel[key(a)]);
  const allOn = rows.length > 0 && chosen.length === rows.length;

  const po = useMutation({
    mutationFn: async () => {
      const byWh = new Map<string, string[]>();
      chosen.forEach((a) => byWh.set(a.warehouse_id, [...(byWh.get(a.warehouse_id) ?? []), a.product_id]));
      let n = 0;
      for (const [warehouseId, productIds] of byWh) {
        n += (await rpc<{ purchaseOrderIds: string[] }>('owner_create_purchase_orders', { p_warehouse: warehouseId, p_products: productIds })).purchaseOrderIds.length;
      }
      return n;
    },
    onSuccess: (n) => { setSel({}); void qc.invalidateQueries({ queryKey: ['reorder'] }); notify(`${n} draft PO(s) created`, 'Grouped by last vendor.'); },
    onError: (e) => notify('PO not created', e instanceof Error ? e.message : String(e)),
  });

  const doExport = () => exportXlsx(`Reorder_${whName.replace(/\s+/g, '-')}_${fileStamp()}`, [{
    name: 'Reorder list',
    columns: [
      { header: 'Warehouse', width: 14 }, { header: 'Item code', width: 16 }, { header: 'Item name', width: 36 },
      { header: 'In stock', kind: 'number' }, { header: 'In transit', kind: 'number' }, { header: 'Reorder level', kind: 'number' },
      { header: 'Suggested order qty', kind: 'number', width: 20 }, { header: 'Last vendor', width: 26 },
      { header: 'Last purchase date', kind: 'date', width: 18 },
      { header: 'Last billed cost / unit', kind: 'money', width: 22 }, { header: 'Last net cost / unit', kind: 'money', width: 20 },
    ],
    rows: (chosen.length ? chosen : rows).map((a) => [
      nameOf(a.warehouse_id, a.warehouse_code), a.sku_code, a.name, Number(a.qty_on_hand), Number(a.qty_in_transit), Number(a.threshold),
      Number(a.suggested_qty_base), a.last_vendor_name, a.last_purchase_date,
      a.last_billed_cost_base != null ? Number(a.last_billed_cost_base) : null,
      a.last_effective_cost_base != null ? Number(a.last_effective_cost_base) : null,
    ]),
  }]).catch((e) => notify('Export failed', e instanceof Error ? e.message : String(e)));

  return (
    <Screen>
      <WarehouseSwitch />
      <Field label="Search by item name, code or vendor" value={search} onChangeText={setSearch} autoCapitalize="none" />
      <Toolbar>
        <SmallButton icon="options-outline" title="Set reorder levels in bulk" onPress={() => setBulk(true)} />
        <SmallButton title={allOn ? 'Clear selection' : 'Select all'} onPress={() =>
          setSel(allOn ? {} : Object.fromEntries(rows.map((a) => [key(a), true])))} disabled={!rows.length} />
        <SmallButton icon="⬇" title={chosen.length ? `Export ${chosen.length} selected to Excel` : 'Export list to Excel'}
          onPress={doExport} disabled={!rows.length} />
        <Label muted>{rows.length} item(s) at or below reorder level</Label>
      </Toolbar>

      {rows.map((a) => {
        const on = !!sel[key(a)];
        return (
          <Pressable key={key(a)} onPress={() => setSel((s) => ({ ...s, [key(a)]: !on }))}>
            <Card>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={{ color: t.text, fontWeight: '700', fontSize: 16 }}>{on ? '☑' : '☐'} {a.name}</Text>
                  <Text style={{ color: t.textSecondary }}>Code: <Text style={{ fontWeight: '700', color: t.text }}>{a.sku_code}</Text> · {nameOf(a.warehouse_id, a.warehouse_code)}</Text>
                </View>
                <View style={{ alignItems: 'flex-end' }}>
                  <Text style={{ color: a.qty_on_hand <= 0 ? t.danger : t.warning, fontWeight: '700' }}>
                    {a.qty_on_hand <= 0 ? '● Out of stock' : '▲ Low'}
                  </Text>
                  <Label muted>{a.qty_on_hand} in stock · level {a.threshold}</Label>
                </View>
              </View>
              <Label>
                Order {a.suggested_qty_base}{a.qty_in_transit ? ` · ${a.qty_in_transit} already in transit` : ''}
                {' '}· Last: {a.last_vendor_name ?? '—'} · billed {a.last_billed_cost_base != null ? formatINR(a.last_billed_cost_base) : '—'}
                {' '}· net {a.last_effective_cost_base != null ? formatINR(a.last_effective_cost_base) : '—'}
              </Label>
            </Card>
          </Pressable>
        );
      })}
      {!rows.length ? <Label muted>{q.isLoading ? 'Loading…' : 'Nothing below reorder level 🎉'}</Label> : null}
      <Button title={`Create purchase order for ${chosen.length} item(s)`} onPress={() => po.mutate()}
        busy={po.isPending} disabled={!chosen.length} />
      <BulkReorder visible={bulk} onClose={() => setBulk(false)} />
    </Screen>
  );
}
