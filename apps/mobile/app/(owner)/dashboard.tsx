import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { View } from 'react-native';
import { formatINR } from '@wh/shared';
import { rpc } from '../../src/api/client';
import { Card, Chips, HBar, Label, Screen, Stat } from '../../src/components/ui';
import { WarehouseBars, type TrendPoint } from '../../src/components/WarehouseBars';
import { useSelectedWarehouseName, WarehouseSwitch } from '../../src/components/WarehouseSwitch';
import { todayIST } from '../../src/lib/ids';
import { useOwnerWarehouse, useWarehouses } from '../../src/lib/warehouse';
import { monthLabel, monthStart } from '../../src/lib/dates';

interface TopRow { product_id: string; sku_code?: string; product_name: string; units_base: number; revenue_excl_gst: number; rank_by_revenue: number }

export default function Dashboard() {
  const wh = useOwnerWarehouse((s) => s.id);
  const whName = useSelectedWarehouseName();
  const whs = useWarehouses();
  const [topPeriod, setTopPeriod] = useState<'This month' | 'Last 12 months'>('This month');
  const today = todayIST();
  const m0 = monthStart(0);
  const m11 = monthStart(11);

  const month = useQuery({
    queryKey: ['trend-day', m0, today, wh],
    queryFn: () => rpc<TrendPoint[]>('owner_sales_trend', { p_from: m0, p_to: today, p_granularity: 'day', p_warehouse: wh }),
  });
  const year = useQuery({
    queryKey: ['trend-month', m11, today, wh],
    queryFn: () => rpc<TrendPoint[]>('owner_sales_trend', { p_from: m11, p_to: today, p_granularity: 'month', p_warehouse: wh }),
  });
  const stock = useQuery({
    queryKey: ['stock-overview'],
    queryFn: () => rpc<{ warehouses: { warehouse_id: string; warehouse_code: string; valuation: number }[] }>('owner_stock_overview'),
  });
  const topFrom = topPeriod === 'This month' ? m0 : m11;
  const top = useQuery({
    queryKey: ['top', topFrom, today, wh],
    queryFn: () => rpc<TopRow[]>('owner_top_items', { p_from: topFrom, p_to: today, p_warehouse: wh, p_limit: 10 }),
  });
  const alerts = useQuery({ queryKey: ['reorder'], queryFn: () => rpc<{ warehouse_id: string }[]>('owner_reorder_alerts') });

  const sum = (pts: TrendPoint[] | undefined, pred: (p: TrendPoint) => boolean = () => true) =>
    (pts ?? []).filter(pred).reduce((a, p) => a + Number(p.revenue_excl_gst), 0);
  const salesToday = sum(month.data, (p) => p.bucket === today);
  const salesMonth = sum(month.data);
  const valuation = (stock.data?.warehouses ?? []).filter((w) => !wh || w.warehouse_id === wh).reduce((a, w) => a + Number(w.valuation), 0);
  const toReorder = (alerts.data ?? []).filter((a) => !wh || a.warehouse_id === wh).length;

  const codes = (whs.data ?? []).filter((w) => !wh || w.id === wh).map((w) => w.code);
  const buckets = Array.from({ length: 12 }, (_, i) => monthStart(11 - i));
  const topRows = [...(top.data ?? [])].sort((a, b) => a.rank_by_revenue - b.rank_by_revenue).slice(0, 10);

  return (
    <Screen>
      <WarehouseSwitch />
      <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap' }}>
        <Stat label="Sales today" value={formatINR(salesToday)} sub="excl. GST" />
        <Stat label={`Sales in ${monthLabel(m0)}`} value={formatINR(salesMonth)} sub="excl. GST" />
        <Stat label="Stock value" value={formatINR(valuation)} sub={`at cost · ${toReorder} to reorder`} />
      </View>

      <Card title={`Sales per month · ${whName}`}>
        <WarehouseBars points={year.data ?? []} warehouses={codes} buckets={buckets} formatBucket={monthLabel} formatAxis={(b) => monthLabel(b).slice(0, 3)}
          colorCodes={(whs.data ?? []).map((w) => w.code)}
          names={Object.fromEntries((whs.data ?? []).map((w) => [w.code, w.name]))} />
      </Card>

      <Card title={`Top sellers by revenue · ${whName}`}>
        <Chips options={['This month', 'Last 12 months'] as const} value={topPeriod} onChange={setTopPeriod} />
        {topRows.map((r, _i, all) => (
          <HBar key={r.product_id} label={`#${r.rank_by_revenue} ${r.product_name}`} value={Number(r.revenue_excl_gst)}
            max={Number(all[0]?.revenue_excl_gst ?? 0)} display={formatINR(Number(r.revenue_excl_gst))}
            sub={`${r.sku_code ? `${r.sku_code} · ` : ''}${r.units_base} units sold`} />
        ))}
        {!topRows.length ? <Label muted>{top.isLoading ? 'Loading…' : 'No sales in this period yet'}</Label> : null}
      </Card>
    </Screen>
  );
}
