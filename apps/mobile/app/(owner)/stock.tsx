import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { formatINR } from '@wh/shared';
import { rpc } from '../../src/api/client';
import { Card, Field, Row, Screen } from '../../src/components/ui';

interface Overview {
  warehouses: { warehouse_code: string; warehouse_name: string; valuation: number; skus_in_stock: number }[];
  items: { productId: string; sku: string; name: string; brand: string | null; totalQty: number; totalValue: number; perWarehouse: Record<string, number> }[];
}

/** Multi-warehouse stock with valuation at (net) purchase cost. */
export default function OwnerStock() {
  const [q, setQ] = useState('');
  const o = useQuery({ queryKey: ['stock-overview'], queryFn: () => rpc<Overview>('owner_stock_overview') });
  const items = (o.data?.items ?? []).filter((i) => !q || `${i.name} ${i.sku} ${i.brand ?? ''}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <Screen>
      <Card title="Valuation by warehouse">
        {o.data?.warehouses.map((w) => <Row key={w.warehouse_code} left={w.warehouse_name} sub={`${w.skus_in_stock} SKUs in stock`} right={formatINR(w.valuation)} />)}
      </Card>
      <Field label="Find item" value={q} onChangeText={setQ} />
      <Card>
        {items.map((i) => (
          <Row key={i.productId} left={i.name}
            sub={Object.entries(i.perWarehouse).map(([w, n]) => `${w}: ${n}`).join(' · ')}
            right={`${i.totalQty} · ${formatINR(i.totalValue)}`} />
        ))}
      </Card>
    </Screen>
  );
}
