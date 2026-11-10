import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { formatBreakdown } from '@wh/shared';
import { rpc } from '../../src/api/client';
import { Card, Chips, Field, Label, Row, Screen } from '../../src/components/ui';

interface StockRow {
  product_id: string; sku_code: string; name: string; brand: string | null; specification: string | null;
  qty_on_hand: number; qty_in_transit: number; reorder_level: number; is_low: boolean; uoms: { code: string; factor: number }[];
}

/** Physical counts only — no cost, no value. */
export default function Stock() {
  const [filter, setFilter] = useState<'All' | 'Low'>('All');
  const [q, setQ] = useState('');
  const inv = useQuery({ queryKey: ['inventory', filter], queryFn: () => rpc<StockRow[]>('stock_list', { p_low_only: filter === 'Low' }) });
  const rows = (inv.data ?? []).filter((r) => !q || `${r.name} ${r.sku_code} ${r.brand ?? ''}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <Screen>
      <Field label="Filter" value={q} onChangeText={setQ} placeholder="Name, SKU or brand" />
      <Chips options={['All', 'Low'] as const} value={filter} onChange={setFilter} />
      <Card>
        {rows.map((r) => (
          <Row key={r.product_id} left={`${r.is_low ? '▼ ' : ''}${r.name}`}
            sub={`${r.sku_code} · ${[r.brand, r.specification].filter(Boolean).join(' · ')}${r.qty_in_transit ? ` · ${r.qty_in_transit} in transit` : ''}`}
            right={formatBreakdown(r.qty_on_hand, r.uoms)} />
        ))}
        {!rows.length ? <Label muted>{inv.isLoading ? 'Loading…' : 'Nothing here'}</Label> : null}
      </Card>
    </Screen>
  );
}
