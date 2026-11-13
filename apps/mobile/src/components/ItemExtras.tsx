/** Item photos, hide / show, and merging a duplicate item into this one. */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { useState } from 'react';
import { View } from 'react-native';
import { itemPhotoUrl, rpc, uploadItemPhoto } from '../api/client';
import type { ProductHit } from '../api/types';
import { useAuth } from '../auth/store';
import { confirmAsk, notify } from '../lib/dialogs';
import { supabase } from '../lib/supabase';
import { ItemPicker } from './ItemPicker';
import { Card, Label, SmallButton, Toolbar } from './ui';

interface Photo { id: string; storage_key: string; is_primary: boolean }

export function ItemExtras({ productId, active, name, onClose }: { productId: string; active: boolean; name: string; onClose: () => void }) {
  const qc = useQueryClient();
  const fullOwner = useAuth((s) => s.user?.role) === 'OWNER';
  const photos = useQuery({ queryKey: ['item-photos', productId], queryFn: () => rpc<Photo[]>('owner_item_photos', { p_product: productId }) });
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const refresh = () => { for (const k of ['item-photos', 'owner-stock', 'owner-product', 'search', 'inventory']) void qc.invalidateQueries({ queryKey: [k] }); };
  const fail = (e: unknown) => notify('Not done', e instanceof Error ? e.message : String(e));

  const add = async (camera: boolean) => {
    const r = camera ? await ImagePicker.launchCameraAsync({ quality: 0.6, mediaTypes: ['images'] })
      : await ImagePicker.launchImageLibraryAsync({ quality: 0.6, mediaTypes: ['images'] });
    if (r.canceled || !r.assets[0]) return;
    setBusy(true);
    try { const key = await uploadItemPhoto(productId, r.assets[0].uri); await rpc('owner_add_item_photo', { p_product: productId, p_key: key }); refresh(); }
    catch (e) { fail(e); } finally { setBusy(false); }
  };
  const remove = async (p: Photo) => {
    if (!(await confirmAsk('Delete this photo?', undefined, 'Delete'))) return;
    try { const key = await rpc<string>('owner_delete_item_photo', { p_id: p.id }); await supabase.storage.from('product-images').remove([key]); refresh(); } catch (e) { fail(e); }
  };
  const toggle = async () => {
    if (active && !(await confirmAsk(`Hide ${name}?`, 'It stops showing when billing and in searches. History stays. You can show it again from Stock → Hidden items.', 'Hide'))) return;
    rpc('owner_set_item_active', { p_product: productId, p_active: !active }).then(() => { refresh(); notify(active ? 'Item hidden' : 'Item shown again'); if (active) onClose(); }, fail);
  };
  const merge = async (dup: ProductHit) => {
    if (dup.id === productId) return;
    if (!(await confirmAsk(`Merge "${dup.name}" (${dup.sku_code}) into "${name}"?`,
      `Its stock in every warehouse is added to "${name}", all its bills and history move here, and its code ${dup.sku_code} keeps working as an old code. "${dup.name}" is then deleted. This cannot be undone.`, 'Merge'))) return;
    rpc<{ stock_moved: number }>('owner_merge_items', { p_keep: productId, p_drop: dup.id }).then((r) => { refresh(); notify('Merged', `${Number(r.stock_moved)} in stock moved over.`); }, fail);
  };

  return (
    <View style={{ gap: 12 }}>
      <Card title="Photos" subtitle="The first photo shows in searches so staff pick the right item">
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
          {(photos.data ?? []).map((p) => (
            <View key={p.id} style={{ gap: 4, alignItems: 'center' }}>
              <Image source={{ uri: itemPhotoUrl(p.storage_key) }} style={{ width: 120, height: 120, borderRadius: 10 }} contentFit="cover" />
              <Toolbar>
                {!p.is_primary ? <SmallButton title="Main" onPress={() => void rpc('owner_photo_primary', { p_id: p.id }).then(refresh, fail)} /> : <Label muted>Main photo</Label>}
                <SmallButton title="Delete" kind="danger" onPress={() => void remove(p)} />
              </Toolbar>
            </View>
          ))}
        </View>
        {!photos.data?.length ? <Label muted>No photos yet</Label> : null}
        <Toolbar>
          <SmallButton icon="camera-outline" title="Take photo" onPress={() => void add(true)} disabled={busy} />
          <SmallButton icon="image-outline" title="Choose photo" onPress={() => void add(false)} disabled={busy} />
        </Toolbar>
      </Card>
      <Card title="Hide or merge">
        <Label muted>{active ? 'Hide an item you no longer sell (it must have no stock).' : 'This item is hidden.'}</Label>
        <SmallButton icon={active ? 'eye-off-outline' : 'eye-outline'} title={active ? 'Hide this item' : 'Show this item again'} onPress={() => void toggle()} />
        {fullOwner ? (
          <>
            <Label muted>Same item entered twice? Pick the duplicate — it is folded into this one.</Label>
            <SmallButton icon="git-merge-outline" title="Merge a duplicate into this item" onPress={() => setPicking(true)} />
          </>
        ) : null}
      </Card>
      <ItemPicker visible={picking} onClose={() => setPicking(false)} onPick={(p) => { setPicking(false); void merge(p); }} />
    </View>
  );
}
