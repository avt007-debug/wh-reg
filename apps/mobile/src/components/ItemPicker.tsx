/**
 * No barcodes, so finding an item fast is everything:
 *   • type-ahead search over name, brand, category, spec, SKU and local aliases
 *     (typo-tolerant: "spaner", "pechkas", "drill machin")
 *   • or drill down Brand → Category → (results)
 *   • every hit shows the reference photo + specification + stock on hand
 *   • staff can add a local alias from the result row (long-press)
 */
import { useQuery } from '@tanstack/react-query';
import { Image } from 'expo-image';
import { useEffect, useMemo, useState } from 'react';
import { Alert, FlatList, Modal, Pressable, Text, TextInput, View } from 'react-native';
import { formatBreakdown } from '@wh/shared';
import { api } from '../api/client';
import { toUoms, type ProductHit } from '../api/types';
import { useTheme } from '../theme';
import { Button, Chips, Label } from './ui';

interface Category { id: string; parent_id: string | null; name: string; path: string }

function useDebounced<T>(v: T, ms = 200) {
  const [d, setD] = useState(v);
  useEffect(() => { const id = setTimeout(() => setD(v), ms); return () => clearTimeout(id); }, [v, ms]);
  return d;
}

export function ItemPicker({ visible, onClose, onPick }: { visible: boolean; onClose: () => void; onPick: (p: ProductHit) => void }) {
  const t = useTheme();
  const [q, setQ] = useState('');
  const [brandId, setBrandId] = useState<string | null>(null);
  const [cat, setCat] = useState<Category | null>(null);
  const dq = useDebounced(q);

  const tree = useQuery({
    queryKey: ['catalog-tree'],
    queryFn: () => api<{ brands: { id: string; name: string }[]; categories: Category[] }>('/catalog/tree'),
    staleTime: 10 * 60_000,
  });
  const children = useMemo(
    () => (tree.data?.categories ?? []).filter((c) => c.parent_id === (cat?.id ?? null)),
    [tree.data, cat]);

  const params = new URLSearchParams({ q: dq, limit: '40' });
  if (brandId) params.set('brandId', brandId);
  if (cat) params.set('categoryId', cat.id);
  const results = useQuery({
    queryKey: ['search', dq, brandId, cat?.id],
    queryFn: () => api<ProductHit[]>(`/products/search?${params}`),
    enabled: visible && (dq.length >= 2 || !!brandId || !!cat),
  });

  const addAlias = (p: ProductHit) =>
    Alert.prompt?.('Add local name', `What do customers call "${p.name}"?`, async (alias) => {
      if (alias?.trim()) await api(`/products/${p.id}/aliases`, { body: { alias: alias.trim() } });
    });

  const brands = tree.data?.brands ?? [];
  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: t.surface, padding: 16, gap: 10, paddingTop: 48 }}>
        <TextInput
          autoFocus value={q} onChangeText={setQ} placeholder="Search item, brand, size or local name…"
          placeholderTextColor={t.textMuted} autoCorrect={false}
          style={{ borderWidth: 1, borderColor: t.border, borderRadius: 10, padding: 14, fontSize: 17, color: t.text, backgroundColor: t.card }}
        />
        <Chips options={['All', ...brands.map((b) => b.name)]} value={brands.find((b) => b.id === brandId)?.name ?? 'All'}
          onChange={(n) => setBrandId(brands.find((b) => b.name === n)?.id ?? null)} />
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
          <Pressable onPress={() => setCat(null)}><Text style={{ color: t.accent }}>All categories</Text></Pressable>
          {cat ? <Text style={{ color: t.textSecondary }}>› {cat.path}</Text> : null}
        </View>
        {children.length ? (
          <Chips options={children.map((c) => c.name)} value={null}
            onChange={(n) => setCat(children.find((c) => c.name === n) ?? null)} />
        ) : null}

        <FlatList
          data={results.data ?? []}
          keyExtractor={(p) => p.id}
          keyboardShouldPersistTaps="handled"
          ListEmptyComponent={<Label muted>{results.isFetching ? 'Searching…' : 'Type at least 2 letters or pick a brand / category'}</Label>}
          renderItem={({ item: p }) => (
            <Pressable onPress={() => { onPick(p); setQ(''); onClose(); }} onLongPress={() => addAlias(p)}
              style={{ flexDirection: 'row', gap: 12, paddingVertical: 10, borderBottomWidth: 0.5, borderColor: t.border }}>
              <Image source={p.image_url ? { uri: p.image_url } : undefined} contentFit="cover"
                style={{ width: 64, height: 64, borderRadius: 8, backgroundColor: t.border }} />
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={{ color: t.text, fontSize: 16, fontWeight: '600' }}>{p.name}</Text>
                <Text style={{ color: t.textSecondary }}>{[p.brand, p.specification].filter(Boolean).join(' · ')}</Text>
                <Text style={{ color: t.textMuted, fontSize: 12 }}>
                  {p.sku_code}{p.aliases?.length ? `  ·  aka ${p.aliases.join(', ')}` : ''}
                </Text>
              </View>
              <View style={{ alignItems: 'flex-end', justifyContent: 'center' }}>
                <Text style={{ color: p.qty_on_hand > 0 ? t.text : t.danger, fontWeight: '600' }}>
                  {formatBreakdown(p.qty_on_hand, toUoms(p))}
                </Text>
                <Label muted>in stock</Label>
              </View>
            </Pressable>
          )}
        />
        <Button title="Close" kind="secondary" onPress={onClose} />
      </View>
    </Modal>
  );
}
