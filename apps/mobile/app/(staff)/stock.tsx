import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { formatBreakdown } from '@wh/shared';
import { rpc } from '../../src/api/client';
import { ClockBanner } from '../../src/components/ClockBanner';
import { Card, Chips, Empty, Field, Label, Notice, Row, Screen } from '../../src/components/ui';
import { useTheme } from '../../src/theme';

interface Wh { id: string; code: string; name: string }
interface Item {
  product_id: string; sku_code: string; name: string; brand: string | null; specification: string | null;
  aliases: string[] | null; uoms: { code: string; factor: number }[]; by_warehouse: Record<string, number> | null;
  in_transit: number; total: number;
}
interface AllStock { my_warehouse_id: string | null; warehouses: Wh[]; items: Item[] }
interface LowRow { product_id: string; sku_code: string; name: string; brand: string | null; qty_on_hand: number; reorder_level: number; uoms: { code: string; factor: number }[] }

const ALL = 'ALL';
const LOW = 'LOW';

/** Quantities in every warehouse — no cost, no value. */
export default function Stock() {
  const t = useTheme();
  const [q, setQ] = useState('');
  const [dq, setDq] = useState('');
  useEffect(() => { const id = setTimeout(() => setDq(q.trim()), 250); return () => clearTimeout(id); }, [q]);
  const [view, setView] = useState<string>(ALL);

  const all = useQuery({ queryKey: ['stock-all', dq], queryFn: () => rpc<AllStock>('stock_all_warehouses', { p_q: dq || null }) });
  const low = useQuery({ queryKey: ['inventory', 'Low'], enabled: view === LOW, queryFn: () => rpc<LowRow[]>('stock_list', { p_low_only: true }) });

  const whs = all.data?.warehouses ?? [];
  const mine = all.data?.my_warehouse_id ?? null;
  const myName = whs.find((w) => w.id === mine)?.name;
  const items = (all.data?.items ?? []).filter((it) => view === ALL || view === LOW || Number(it.by_warehouse?.[view] ?? 0) !== 0);
  const viewName = whs.find((w) => w.id === view)?.name;

  return (
    <Screen>
      <ClockBanner />
      <Field label="Search" value={q} onChangeText={setQ} placeholder="Material No., old code, name or company" autoCapitalize="characters" />
      <Chips options={[ALL, ...whs.map((w) => w.id), LOW]} value={view} onChange={setView}
        format={(v) => (v === ALL ? 'All warehouses' : v === LOW ? `Low stock${myName ? ` · ${myName}` : ''}` : `${whs.find((w) => w.id === v)?.name ?? ''}${v === mine ? ' (mine)' : ''}`)} />

      {view === LOW ? (
        <Card title={`Low stock in ${myName ?? 'my warehouse'}`} subtitle="At or below the reorder level">
          {(low.data ?? []).map((r) => <Row key={r.product_id} left={r.name} sub={`${r.sku_code}${r.brand ? ` · ${r.brand}` : ''} · reorder at ${r.reorder_level}`} right={formatBreakdown(r.qty_on_hand, r.uoms)} />)}
          {!low.data?.length ? <Empty icon="checkmark-circle-outline" text={low.isLoading ? 'Loading…' : 'Nothing is low right now'} /> : null}
        </Card>
      ) : (
        <Card title={view === ALL ? `In stock · all warehouses (${items.length})` : `In stock at ${viewName} (${items.length})`}
          subtitle="Quantities only. Choose the dispatch warehouse on the Sales page.">
          {items.map((it) => (
            <View key={it.product_id} style={{ paddingVertical: 10, borderBottomWidth: 0.5, borderColor: t.border, gap: 6 }}>
              <View>
                <Text style={{ color: t.text, fontWeight: '700', fontSize: 15 }}>{it.name}</Text>
                <Text style={{ color: t.textMuted, fontSize: 12.5 }}>
                  {[it.sku_code + (it.aliases?.length ? ` (old ${it.aliases.join(', ')})` : ''), it.brand, it.specification].filter(Boolean).join(' · ')}
                </Text>
              </View>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                {whs.filter((w) => view === ALL || w.id === view).map((w) => {
                  const qty = Number(it.by_warehouse?.[w.id] ?? 0);
                  const isMine = w.id === mine;
                  return (
                    <View key={w.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999,
                      backgroundColor: qty > 0 ? (isMine ? t.accentSoft : t.cardAlt) : 'transparent', borderWidth: 1, borderColor: qty > 0 ? (isMine ? t.accent : t.hairline) : t.hairline }}>
                      <Text style={{ color: t.textSecondary, fontSize: 12, fontWeight: '700' }}>{w.code}{isMine ? ' ★' : ''}</Text>
                      <Text style={{ color: qty > 0 ? t.text : t.textMuted, fontWeight: '800', fontVariant: ['tabular-nums'] }}>
                        {qty > 0 ? formatBreakdown(qty, it.uoms) : '0'}
                      </Text>
                    </View>
                  );
                })}
                {view === ALL && whs.length > 1 ? (
                  <View style={{ paddingHorizontal: 10, paddingVertical: 6 }}>
                    <Text style={{ color: t.textMuted, fontSize: 12.5 }}>Total {Number(it.total)}{Number(it.in_transit) ? ` · ${Number(it.in_transit)} in transit` : ''}</Text>
                  </View>
                ) : null}
              </View>
            </View>
          ))}
          {!items.length ? <Empty icon="cube-outline" text={all.isLoading ? 'Loading…' : dq ? `Nothing in stock matching “${dq}”` : 'No stock yet'} /> : null}
        </Card>
      )}
      {all.isError ? <Notice tone="danger">Could not load stock. Check the internet connection.</Notice> : null}
      <Label muted>★ = your warehouse</Label>
    </Screen>
  );
}
