/**
 * Stock count: walk the shelves and type what you see. Anyone can count (employees only their own warehouse);
 * the owner then applies it — stock becomes what was counted, only for the items counted.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import { rpc } from '../api/client';
import { isOwner, useAuth } from '../auth/store';
import { dateTimeIST } from '../lib/dates';
import { confirmAsk, notify } from '../lib/dialogs';
import { useWarehouses } from '../lib/warehouse';
import { useTheme } from '../theme';
import { Button, Card, Chips, Field, Label, Notice, Row, SmallButton, Toolbar } from './ui';

interface CountRow { id: string; warehouse_id: string; warehouse: string; warehouse_code: string; brand: string | null; note: string | null; status: 'OPEN' | 'APPLIED' | 'DISCARDED';
  started_by: string; started_at: string; finished_by: string | null; finished_at: string | null; counted: number; result: { changed: number; units_up: number; units_down: number } | null }
interface SheetItem { product_id: string; sku_code: string; name: string; brand: string | null; unit: string; system_qty: number; counted_qty: number | null; counted_by: string | null }

export function StockCount() {
  const t = useTheme();
  const qc = useQueryClient();
  const user = useAuth((s) => s.user);
  const owner = isOwner(user);
  const whs = useWarehouses();
  const [wh, setWh] = useState<string | null>(null);
  const warehouse = owner ? wh ?? whs.data?.[0]?.id ?? null : user?.warehouseId ?? null;
  const counts = useQuery({ queryKey: ['stock-counts', warehouse], enabled: !!warehouse, queryFn: () => rpc<CountRow[]>('stock_counts_list', { p_warehouse: warehouse }) });
  const open = counts.data?.find((c) => c.status === 'OPEN');
  const sheet = useQuery({ queryKey: ['count-sheet', open?.id], enabled: !!open, queryFn: () => rpc<{ items: SheetItem[] }>('stock_count_sheet', { p_count: open!.id }) });
  const [q, setQ] = useState(''); const [only, setOnly] = useState<'All' | 'Not counted' | 'Different'>('All');
  const [typed, setTyped] = useState<Record<string, string>>({});
  useEffect(() => setTyped({}), [open?.id]);
  const refresh = () => { for (const k of ['stock-counts', 'count-sheet', 'owner-stock', 'stock-overview', 'inventory']) void qc.invalidateQueries({ queryKey: [k] }); };
  const fail = (e: unknown) => notify('Not saved', e instanceof Error ? e.message : String(e));

  const start = useMutation({ mutationFn: () => rpc('start_stock_count', { p_warehouse: warehouse, p_note: null, p_brand: null }), onSuccess: refresh, onError: fail });
  const saveLine = (it: SheetItem, v: string) => {
    const val = v.trim() === '' ? null : Number(v);
    if (val != null && (!Number.isFinite(val) || val < 0)) return;
    rpc('save_count_line', { p_count: open!.id, p_product: it.product_id, p_qty: val }).then(() => void qc.invalidateQueries({ queryKey: ['count-sheet'] }), fail);
  };
  const finish = async (apply: boolean) => {
    const counted = (sheet.data?.items ?? []).filter((i) => i.counted_qty != null);
    const diff = counted.filter((i) => Number(i.counted_qty) !== Number(i.system_qty)).length;
    if (!(await confirmAsk(apply ? 'Apply this count?' : 'Throw this count away?', apply
      ? `${counted.length} item(s) counted, ${diff} different from the app. Stock of those ${diff} item(s) becomes what was counted. Items not counted are not changed.`
      : 'Nothing in stock changes.', apply ? 'Apply' : 'Discard'))) return;
    rpc<{ changed: number }>('owner_finish_stock_count', { p_count: open!.id, p_apply: apply })
      .then((r) => { refresh(); notify(apply ? 'Stock updated' : 'Count discarded', apply ? `${r.changed} item(s) corrected` : undefined); }, fail);
  };

  const needle = q.trim().toLowerCase();
  const items = (sheet.data?.items ?? []).filter((i) => (!needle || `${i.sku_code} ${i.name} ${i.brand ?? ''}`.toLowerCase().includes(needle))
    && (only !== 'Not counted' || i.counted_qty == null) && (only !== 'Different' || (i.counted_qty != null && Number(i.counted_qty) !== Number(i.system_qty))));
  const counted = (sheet.data?.items ?? []).filter((i) => i.counted_qty != null).length;

  return (
    <View style={{ gap: 12 }}>
      {owner ? <Chips options={(whs.data ?? []).map((w) => w.id)} value={warehouse} onChange={setWh} format={(v) => whs.data?.find((w) => w.id === v)?.name ?? v} /> : null}
      {!open ? (
        <Card title="Count the stock" subtitle="Start a count, then type the quantity you see on the shelf for each item. Several people can count at the same time.">
          <Button title="Start a stock count" icon="clipboard-outline" onPress={() => start.mutate()} busy={start.isPending} disabled={!warehouse} />
        </Card>
      ) : (
        <>
          <Notice icon="clipboard-outline">{`Count started ${dateTimeIST(open.started_at)} by ${open.started_by}. ${counted} of ${sheet.data?.items.length ?? '…'} item(s) counted. Each number is saved as you leave the box.`}</Notice>
          {owner ? (
            <Toolbar>
              <SmallButton icon="checkmark-done-outline" title="Apply count to stock" kind="primary" onPress={() => void finish(true)} disabled={!counted} />
              <SmallButton title="Discard count" kind="danger" onPress={() => void finish(false)} />
            </Toolbar>
          ) : <Label muted>When everyone has finished, the owner applies the count.</Label>}
          <Field label="Find item (code or name)" value={q} onChangeText={setQ} autoCapitalize="none" />
          <Chips options={['All', 'Not counted', 'Different'] as const} value={only} onChange={setOnly} />
          {items.slice(0, 200).map((i) => {
            const v = typed[i.product_id] ?? (i.counted_qty != null ? String(Number(i.counted_qty)) : '');
            const diff = i.counted_qty != null ? Number(i.counted_qty) - Number(i.system_qty) : null;
            return (
              <View key={i.product_id} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6, borderBottomWidth: 0.5, borderColor: t.border }}>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: t.text, fontWeight: '600' }}>{i.name}</Text>
                  <Label muted>{`${i.sku_code}${i.brand ? ` · ${i.brand}` : ''} · app says ${Number(i.system_qty)} ${i.unit}`}
                    {diff ? <Text style={{ color: diff > 0 ? t.good : t.danger, fontWeight: '700' }}>{`  ${diff > 0 ? '+' : ''}${diff}`}</Text> : null}</Label>
                </View>
                <TextInput value={v} onChangeText={(x) => setTyped((s) => ({ ...s, [i.product_id]: x }))} onBlur={() => typed[i.product_id] !== undefined && saveLine(i, typed[i.product_id]!)}
                  keyboardType="decimal-pad" placeholder="count" placeholderTextColor={t.textMuted}
                  style={{ width: 90, borderWidth: 1, borderColor: i.counted_qty != null ? t.good : t.border, borderRadius: 8, padding: 8, color: t.text, textAlign: 'right', backgroundColor: t.card }} />
              </View>
            );
          })}
          {items.length > 200 ? <Label muted>Showing 200 — search to find others</Label> : null}
        </>
      )}
      <Card title="Earlier counts">
        {(counts.data ?? []).filter((c) => c.status !== 'OPEN').slice(0, 10).map((c) => (
          <Row key={c.id} left={`${dateTimeIST(c.started_at)} · ${c.warehouse_code}`} sub={`${c.counted} counted by ${c.started_by}${c.finished_by ? ` · ${c.status === 'APPLIED' ? 'applied' : 'discarded'} by ${c.finished_by}` : ''}`}
            right={c.status === 'APPLIED' && c.result ? `${c.result.changed} fixed` : c.status.toLowerCase()} />
        ))}
        {!(counts.data ?? []).some((c) => c.status !== 'OPEN') ? <Label muted>No earlier counts</Label> : null}
      </Card>
    </View>
  );
}
