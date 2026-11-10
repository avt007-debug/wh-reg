import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { api } from '../api/client';
import type { Party } from '../api/types';
import { useTheme } from '../theme';
import { Field, Label } from './ui';

/** Customer / vendor type-ahead (name or GSTIN). */
export function PartyPicker({ kind, value, onChange }: { kind: 'customers' | 'vendors'; value: Party | null; onChange: (p: Party | null) => void }) {
  const t = useTheme();
  const [q, setQ] = useState('');
  const list = useQuery({
    queryKey: [kind, q],
    queryFn: () => api<Party[]>(`/${kind}?q=${encodeURIComponent(q)}`),
    enabled: !value && q.length >= 2,
  });
  const label = kind === 'customers' ? 'Customer / Dealer' : 'Vendor';

  if (value) {
    return (
      <Pressable onPress={() => onChange(null)} style={{ gap: 2 }}>
        <Label>{label}</Label>
        <Text style={{ color: t.text, fontSize: 16, fontWeight: '600' }}>{value.name}</Text>
        <Label muted>{value.gstin ?? 'Unregistered'} · tap to change</Label>
      </Pressable>
    );
  }
  return (
    <View style={{ gap: 6 }}>
      <Field label={label} value={q} onChangeText={setQ} placeholder="Name or GSTIN" autoCapitalize="characters" />
      {(list.data ?? []).map((p) => (
        <Pressable key={p.id} onPress={() => { onChange(p); setQ(''); }} style={{ paddingVertical: 8 }}>
          <Text style={{ color: t.text }}>{p.name}</Text>
          <Label muted>{p.gstin ?? 'Unregistered'}</Label>
        </Pressable>
      ))}
    </View>
  );
}
