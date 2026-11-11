import { useQuery } from '@tanstack/react-query';
import { formatINR } from '@wh/shared';
import { rpc } from '../../src/api/client';
import { Card, HBar, Label, Row, Screen } from '../../src/components/ui';
import { todayIST } from '../../src/lib/ids';

const monthStart = () => `${todayIST().slice(0, 7)}-01`;

/** Margin spread, dead stock, and staff / sales-agent performance. */
export default function Insights() {
  const range = { p_from: monthStart(), p_to: todayIST() };
  const qs = JSON.stringify(range);
  const margins = useQuery({ queryKey: ['margins', qs], queryFn: () => rpc<{ category: string; revenue_excl_gst: number; gross_margin: number; margin_pct: number; avg_cost_per_unit: number; avg_price_per_unit: number }[]>('owner_margins', range) });
  const dead = useQuery({ queryKey: ['dead'], queryFn: () => rpc<{ product_id: string; warehouse_code: string; name: string; qty_on_hand: number; valuation: number; days_idle: number }[]>('owner_dead_stock', { p_days: 45 }) });
  const perf = useQuery({ queryKey: ['perf', qs], queryFn: () => rpc<{ staff: { user_id: string; full_name: string; warehouse_code: string; invoices: number; revenue_excl_gst: number; gross_margin: number; overrides_used: number; inward_entries: number }[]; salesAgents: { sales_agent_id: string; agent_name: string; invoices: number; revenue_excl_gst: number; customers: number }[] }>('owner_staff_performance', range) });

  return (
    <Screen>
      <Card title="Margin spread by category (this month)">
        {margins.data?.map((m) => (
          <Row key={m.category} left={m.category}
            sub={`Avg landed ${formatINR(m.avg_cost_per_unit)} → avg sold ${formatINR(m.avg_price_per_unit)} per unit`}
            right={`${m.margin_pct ?? 0}%`} />
        ))}
      </Card>
      <Card title="Staff performance (this month)">
        {perf.data?.staff.map((s, _i, all) => (
          <HBar key={s.user_id} label={`${s.full_name} · ${s.warehouse_code ?? '—'}`} value={s.revenue_excl_gst}
            max={Math.max(...all.map((x) => x.revenue_excl_gst))} display={formatINR(s.revenue_excl_gst)}
            sub={`${s.invoices} invoices · margin ${formatINR(s.gross_margin)} · ${s.inward_entries} inwards · ${s.overrides_used} overrides`} />
        ))}
      </Card>
      <Card title="Sales agents">
        {perf.data?.salesAgents.map((a) => (
          <Row key={a.sales_agent_id} left={a.agent_name} sub={`${a.invoices} invoices · ${a.customers} customers`} right={formatINR(a.revenue_excl_gst)} />
        ))}
      </Card>
      <Card title="Dead stock (no movement 45+ days)">
        {dead.data?.map((d) => (
          <Row key={`${d.warehouse_code}-${d.product_id}`} left={d.name} sub={`${d.warehouse_code} · ${d.qty_on_hand} pcs · idle ${d.days_idle} days`} right={formatINR(d.valuation)} />
        ))}
        {!dead.data?.length ? <Label muted>No dead stock</Label> : null}
      </Card>
    </Screen>
  );
}
