import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { View } from 'react-native';
import { formatINR } from '@wh/shared';
import { rpc } from '../../src/api/client';
import { Card, Chips, HBar, Label, Screen, Stat } from '../../src/components/ui';
import { WarehouseBars, type TrendPoint } from '../../src/components/WarehouseBars';
import { todayIST } from '../../src/lib/ids';

const daysAgo = (n: number) => new Date(Date.now() + 5.5 * 3600_000 - n * 86400_000).toISOString().slice(0, 10);

export default function Dashboard() {
  const [g, setG] = useState<'Daily' | 'Monthly'>('Daily');
  const range = g === 'Daily'
    ? { p_from: daysAgo(13), p_to: todayIST(), p_granularity: 'day' }
    : { p_from: `${daysAgo(365).slice(0, 7)}-01`, p_to: todayIST(), p_granularity: 'month' };
  const qs = JSON.stringify(range);

  const trend = useQuery({ queryKey: ['trend', qs], queryFn: () => rpc<TrendPoint[]>('owner_sales_trend', range) });
  const stock = useQuery({ queryKey: ['stock-overview'], queryFn: () => rpc<{ warehouses: { warehouse_code: string; valuation: number }[] }>('owner_stock_overview') });
  const top = useQuery({ queryKey: ['top', qs], queryFn: () => rpc<{ product_id: string; product_name: string; units_base: number; revenue_excl_gst: number; rank_by_volume: number; rank_by_revenue: number }[]>('owner_top_items', { p_from: range.p_from, p_to: range.p_to, p_limit: 10 }) });
  const alerts = useQuery({ queryKey: ['reorder'], queryFn: () => rpc<unknown[]>('owner_reorder_alerts') });

  const codes = (stock.data?.warehouses ?? []).map((w) => w.warehouse_code);
  const points = trend.data ?? [];
  const today = points.filter((p) => p.bucket === todayIST()).reduce((a, p) => a + p.revenue_excl_gst, 0);
  const period = points.reduce((a, p) => a + p.revenue_excl_gst, 0);
  const valuation = (stock.data?.warehouses ?? []).reduce((a, w) => a + w.valuation, 0);

  return (
    <Screen>
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <Stat label="Sales today (excl. GST)" value={formatINR(today)} />
        <Stat label="Stock value @ cost" value={formatINR(valuation)} sub={`${alerts.data?.length ?? 0} items to reorder`} />
      </View>
      <Card title={`Revenue by warehouse · ${formatINR(period)}`}>
        <Chips options={['Daily', 'Monthly'] as const} value={g} onChange={setG} />
        <WarehouseBars points={points} warehouses={codes} />
      </Card>
      <Card title="Top sellers by revenue">
        {[...(top.data ?? [])].sort((a, b) => a.rank_by_revenue - b.rank_by_revenue).slice(0, 8).map((r, _i, all) => (
          <HBar key={r.product_id} label={`#${r.rank_by_revenue} ${r.product_name}`} value={r.revenue_excl_gst}
            max={all[0]?.revenue_excl_gst ?? 0} display={formatINR(r.revenue_excl_gst)}
            sub={`${r.units_base} units · volume rank #${r.rank_by_volume}`} />
        ))}
        {!top.data?.length ? <Label muted>No sales in this period</Label> : null}
      </Card>
    </Screen>
  );
}
