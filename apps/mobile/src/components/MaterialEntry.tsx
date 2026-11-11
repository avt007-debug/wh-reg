/**
 * "Material No." box on bills: type the code from the Tata price list (or its first letters)
 * → matching items appear → tap one (or press Enter on an exact code) and the line is filled in
 * with description, HSN, GST %, units and the list price — all still editable on the line.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { formatINR } from '@wh/shared';
import { rpc } from '../api/client';
import type { ProductHit } from '../api/types';
import { useTheme } from '../theme';
import { Card, Label, SmallButton } from './ui';

export function MaterialEntry({ onPick, onCreateNew, showPrice = true }: { onPick: (p: ProductHit) => void; onCreateNew?: (code: string) => void; showPrice?: boolean }) {
  const t = useTheme();
  const [code, setCode] = useState('');
  const [dq, setDq] = useState('');
  useEffect(() => { const id = setTimeout(() => setDq(code.trim().toUpperCase()), 200); return () => clearTimeout(id); }, [code]);
  const hits = useQuery({
    queryKey: ['material', dq], enabled: dq.length >= 2, staleTime: 60_000,
    queryFn: () => rpc<ProductHit[]>('find_material', { p_code: dq, lim: 8 }),
  });
  const list = dq.length >= 2 ? hits.data ?? [] : [];
  const exact = list.find((p) => p.sku_code === dq);
  const pick = (p: ProductHit) => { onPick(p); setCode(''); setDq(''); };

  return (
    <Card title="Add item by Material No." icon="barcode-outline" subtitle="Type the code from the price list, e.g. AXE001 or SPC004 — details fill in automatically">
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderColor: exact ? t.good : t.border, borderRadius: 10, backgroundColor: t.cardAlt, paddingHorizontal: 12 }}>
        <Ionicons name="search" size={18} color={t.textMuted} />
        <TextInput value={code} onChangeText={(v) => setCode(v.toUpperCase())} autoCapitalize="characters" autoCorrect={false}
          placeholder="Material No." placeholderTextColor={t.textMuted} accessibilityLabel="Material No."
          onSubmitEditing={() => { if (exact) pick(exact); else if (list.length === 1) pick(list[0]!); }}
          style={{ flex: 1, color: t.text, fontSize: 17, fontWeight: '700', letterSpacing: 0.5, paddingVertical: 12 }} />
        {code ? <Pressable onPress={() => { setCode(''); setDq(''); }} accessibilityLabel="Clear"><Ionicons name="close-circle" size={20} color={t.textMuted} /></Pressable> : null}
      </View>
      {dq.length >= 2 && hits.isFetching && !list.length ? <Label muted>Looking up…</Label> : null}
      {dq.length >= 2 && !hits.isFetching && !list.length ? (
        <View style={{ gap: 8 }}>
          <Label muted>No item with Material No. starting “{dq}”. Search by name below, or add it as a new item.</Label>
          {onCreateNew ? <SmallButton title={`Add new item “${dq}”`} icon="add" kind="primary" onPress={() => { onCreateNew(dq); setCode(''); setDq(''); }} /> : null}
        </View>
      ) : null}
      {list.map((p) => (
        <Pressable key={p.id} onPress={() => pick(p)} accessibilityRole="button" accessibilityLabel={`Add ${p.sku_code} ${p.name}`}
          style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 10, padding: 10, borderRadius: 10, borderWidth: 1,
            borderColor: p.sku_code === dq ? t.good : t.border, backgroundColor: pressed ? t.accentSoft : t.card })}>
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={{ color: t.text, fontWeight: '800' }}>{p.sku_code} <Text style={{ fontWeight: '500' }}>· {p.name}</Text></Text>
            <Text style={{ color: t.textMuted, fontSize: 12.5 }}>
              {[p.brand, p.hsn_code && `HSN ${p.hsn_code}`, `GST ${Number(p.default_gst_rate)}%`, p.specification, `In stock ${Number(p.qty_on_hand)}`].filter(Boolean).join(' · ')}
            </Text>
          </View>
          {showPrice && p.default_selling_price != null ? (
            <View style={{ alignItems: 'flex-end' }}>
              <Text style={{ color: t.text, fontWeight: '800' }}>{formatINR(Number(p.default_selling_price))}</Text>
              <Text style={{ color: t.textMuted, fontSize: 11 }}>per pc excl. GST</Text>
            </View>
          ) : null}
          <Ionicons name="add-circle" size={24} color={t.accent} />
        </Pressable>
      ))}
    </Card>
  );
}
