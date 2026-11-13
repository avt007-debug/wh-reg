/** Fold a duplicate customer / supplier into the one to keep. */
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Pressable, Text } from 'react-native';
import { formatINR } from '@wh/shared';
import { rpc } from '../api/client';
import { confirmAsk, notify } from '../lib/dialogs';
import { useTheme } from '../theme';
import { Sheet } from './Sheet';
import { Field, Label, Row } from './ui';

const n = (x: unknown) => Number(x ?? 0);

export function MergeSheet<T extends { id: string; name: string; gstin: string | null; phone: string | null; balance?: number }>({ keep, all, onClose, kind = 'customer' }: {
  keep: T | null; all: T[]; onClose: () => void; kind?: 'customer' | 'supplier';
}) {
  const t = useTheme();
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  useEffect(() => setQ(''), [keep]);
  const others = all.filter((x) => x.id !== keep?.id && (!q.trim() || `${x.name} ${x.gstin ?? ''} ${x.phone ?? ''}`.toLowerCase().includes(q.trim().toLowerCase()))).slice(0, 30);
  const go = async (drop: T) => {
    if (!keep) return;
    if (!(await confirmAsk(`Merge "${drop.name}" into "${keep.name}"?`, `All bills and payments of "${drop.name}" move to "${keep.name}", then "${drop.name}" is deleted. This cannot be undone.`, 'Merge'))) return;
    try {
      await rpc(kind === 'customer' ? 'owner_merge_customers' : 'owner_merge_vendors', { p_keep: keep.id, p_drop: drop.id });
      for (const k of ['owner-customers', 'owner-suppliers', 'owner-ledger', 'sales-month', 'purchases-month']) void qc.invalidateQueries({ queryKey: [k] });
      notify('Merged'); onClose();
    } catch (e) { notify('Not merged', e instanceof Error ? e.message : String(e)); }
  };
  return (
    <Sheet visible={!!keep} title={`Merge into ${keep?.name ?? ''}`} subtitle={`Pick the duplicate ${kind} to fold into this one`} onClose={onClose}>
      <Field label="Search" value={q} onChangeText={setQ} autoCapitalize="none" />
      {others.map((x) => (
        <Pressable key={x.id} onPress={() => void go(x)} style={{ paddingVertical: 10, borderBottomWidth: 0.5, borderColor: t.border }}>
          <Text style={{ color: t.text, fontWeight: '700' }}>{x.name}</Text>
          <Label muted>{[x.gstin ?? 'Unregistered', x.phone, x.balance != null ? `balance ${formatINR(n(x.balance))}` : null].filter(Boolean).join(' · ')}</Label>
        </Pressable>
      ))}
      <Row left="Tip" sub="Keep the one with the right GSTIN and name; the other is removed." />
    </Sheet>
  );
}
