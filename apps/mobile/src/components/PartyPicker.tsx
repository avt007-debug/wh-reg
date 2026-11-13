import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { q as run } from '../api/client';
import { supabase } from '../lib/supabase';
import type { Party } from '../api/types';
import { useTheme } from '../theme';
import { Field, Label } from './ui';

/** Customer / vendor type-ahead (name or GSTIN). */
export function PartyPicker({ kind, value, onChange }: { kind: 'customers' | 'vendors'; value: Party | null; onChange: (p: Party | null) => void }) {
  const t = useTheme();
  const [q, setQ] = useState('');
  const list = useQuery({
    queryKey: [kind, q],
    queryFn: () => {
      const term = q.replace(/[,()%*]/g, ' ').trim();     // keep PostgREST filter syntax intact
      return run<Party[]>(supabase.from(kind).select((kind === 'vendors' ? 'id, name, gstin, state_code, phone, default_discount_pct' : 'id, name, gstin, state_code, phone') as '*').eq('is_active', true)
        .or(`name.ilike.%${term}%,gstin.eq.${term.toUpperCase()}`).order('name').limit(30));
    },
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
