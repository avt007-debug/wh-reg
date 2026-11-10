import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Alert, Pressable, Text, View } from 'react-native';
import { formatINR } from '@wh/shared';
import { rpc } from '../../src/api/client';
import { Button, Card, Label, Screen } from '../../src/components/ui';
import { useTheme } from '../../src/theme';

interface Alert_ {
  warehouse_id: string; warehouse_code: string; product_id: string; sku_code: string; name: string;
  qty_on_hand: number; qty_in_transit: number; threshold: number; suggested_qty_base: number;
  last_vendor_name: string | null; last_billed_cost_base: number | null; last_effective_cost_base: number | null;
}

/** Current Stock ≤ Minimum Reorder Threshold, with last price & vendor; select → one-click PO. */
export default function Reorder() {
  const t = useTheme();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['reorder'], queryFn: () => rpc<Alert_[]>('owner_reorder_alerts') });
  const [sel, setSel] = useState<Record<string, boolean>>({});
  const key = (a: Alert_) => `${a.warehouse_id}:${a.product_id}`;

  const po = useMutation({
    mutationFn: async () => {
      const chosen = (q.data ?? []).filter((a) => sel[key(a)]);
      const byWh = new Map<string, string[]>();
      chosen.forEach((a) => byWh.set(a.warehouse_id, [...(byWh.get(a.warehouse_id) ?? []), a.product_id]));
      let n = 0;
      for (const [warehouseId, productIds] of byWh) {
        n += (await rpc<{ purchaseOrderIds: string[] }>('owner_create_purchase_orders', { p_warehouse: warehouseId, p_products: productIds })).purchaseOrderIds.length;
      }
      return n;
    },
    onSuccess: (n) => { setSel({}); void qc.invalidateQueries({ queryKey: ['reorder'] }); Alert.alert(`${n} draft PO(s) created`, 'Grouped by last vendor.'); },
  });

  return (
    <Screen>
      {(q.data ?? []).map((a) => {
        const on = !!sel[key(a)];
        return (
          <Pressable key={key(a)} onPress={() => setSel((s) => ({ ...s, [key(a)]: !on }))}>
            <Card>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                <Text style={{ color: t.text, fontWeight: '700', flex: 1 }}>{on ? '☑' : '☐'} {a.name}</Text>
                <Text style={{ color: a.qty_on_hand <= 0 ? t.danger : t.warning, fontWeight: '700' }}>
                  {a.qty_on_hand <= 0 ? '● Out' : '▲ Low'} {a.qty_on_hand}/{a.threshold}
                </Text>
              </View>
              <Label muted>{a.warehouse_code} · {a.sku_code}{a.qty_in_transit ? ` · ${a.qty_in_transit} in transit` : ''}</Label>
              <Label>
                Last: {a.last_vendor_name ?? '—'} · billed {a.last_billed_cost_base != null ? formatINR(a.last_billed_cost_base) : '—'}
                {' '}· net {a.last_effective_cost_base != null ? formatINR(a.last_effective_cost_base) : '—'} · suggest {a.suggested_qty_base}
              </Label>
            </Card>
          </Pressable>
        );
      })}
      {!q.data?.length ? <Label muted>{q.isLoading ? 'Loading…' : 'Nothing below reorder level 🎉'}</Label> : null}
      <Button title={`Create PO for ${Object.values(sel).filter(Boolean).length} item(s)`} onPress={() => po.mutate()}
        busy={po.isPending} disabled={!Object.values(sel).some(Boolean)} />
    </Screen>
  );
}
