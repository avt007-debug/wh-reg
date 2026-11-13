/** Activity log: who did what and when — bills, purchases, payments, stock changes, logins, clock in/out. */
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { rpc } from '../../src/api/client';
import { Chips, Label, Screen, SmallButton } from '../../src/components/ui';
import { dateTimeIST } from '../../src/lib/dates';
import { useTheme } from '../../src/theme';

interface Ev { at: string; kind: string; text: string; user_id: string | null; who: string | null }
const ICON: Record<string, string> = { SALE: '🧾', PURCHASE: '📦', PAYMENT: '💰', SUPPLIER_PAYMENT: '💸', EXPENSE: '🧮', STOCK: '📊', TRANSFER: '🚚',
  RETURN: '↩️', CLOCK: '⏰', LOGIN: '🔑', EDIT: '✏️', CHANGE: '✏️', MERGE: '🔗', BULK_PRICE: '🏷', INSERT: '➕', DELETE: '🗑' };
const KINDS = ['All', 'Bills', 'Money', 'Stock', 'People'] as const;
const IN: Record<(typeof KINDS)[number], string[] | null> = { All: null, Bills: ['SALE', 'PURCHASE', 'RETURN', 'EDIT', 'CHANGE'], Money: ['PAYMENT', 'SUPPLIER_PAYMENT', 'EXPENSE'],
  Stock: ['STOCK', 'TRANSFER', 'MERGE', 'BULK_PRICE'], People: ['CLOCK', 'LOGIN'] };

export default function Activity() {
  const t = useTheme();
  const users = useQuery({ queryKey: ['owner-users'], queryFn: () => rpc<{ id: string; full_name: string }[]>('owner_list_users') });
  const [who, setWho] = useState<string>('');
  const [kind, setKind] = useState<(typeof KINDS)[number]>('All');
  const q = useInfiniteQuery({
    queryKey: ['activity', who],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => rpc<Ev[]>('owner_activity', { p_limit: 100, p_before: pageParam, p_user: who || null }),
    getNextPageParam: (last) => (last.length === 100 ? last[last.length - 1]!.at : undefined),
  });
  const rows = (q.data?.pages.flat() ?? []).filter((e) => !IN[kind] || IN[kind]!.includes(e.kind));
  let day = '';
  return (
    <Screen>
      <Chips options={['', ...(users.data ?? []).map((u) => u.id)]} value={who} onChange={setWho} format={(v) => (v ? users.data?.find((u) => u.id === v)?.full_name ?? v : 'Everyone')} />
      <Chips options={KINDS} value={kind} onChange={setKind} />
      {rows.map((e, i) => {
        const d = new Date(e.at).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });
        const head = d !== day ? (day = d) : null;
        return (
          <View key={`${e.at}-${i}`}>
            {head ? <Text style={{ color: t.textSecondary, fontWeight: '800', marginTop: 10 }}>{head}</Text> : null}
            <View style={{ flexDirection: 'row', gap: 8, paddingVertical: 6, borderBottomWidth: 0.5, borderColor: t.border }}>
              <Text style={{ width: 24 }}>{ICON[e.kind] ?? '•'}</Text>
              <View style={{ flex: 1 }}>
                <Text style={{ color: t.text }}>{e.text}</Text>
                <Label muted>{`${dateTimeIST(e.at).split(' ').slice(1).join(' ') || dateTimeIST(e.at)} · ${e.who ?? 'system'}`}</Label>
              </View>
            </View>
          </View>
        );
      })}
      {q.isLoading ? <Label muted>Loading…</Label> : null}
      {q.hasNextPage ? <SmallButton title="Show older" onPress={() => void q.fetchNextPage()} disabled={q.isFetchingNextPage} /> : null}
    </Screen>
  );
}
