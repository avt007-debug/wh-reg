/** Owner: rename, hide or bring back companies (brands). */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Modal, ScrollView, Text, View } from 'react-native';
import { q } from '../api/client';
import { askText, confirmAsk, notify } from '../lib/dialogs';
import { supabase } from '../lib/supabase';
import { useTheme } from '../theme';
import { Card, Label, Row, SmallButton } from './ui';

interface Brand { id: string; name: string; is_active: boolean }

export function CompanyEditor({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const t = useTheme();
  const qc = useQueryClient();
  const all = useQuery({
    queryKey: ['brands-all'], enabled: visible,
    queryFn: () => q<Brand[]>(supabase.from('brands').select('id, name, is_active').order('name')),
  });
  const refresh = () => {
    for (const k of ['brands', 'brands-all', 'catalog-tree', 'owner-stock', 'search']) void qc.invalidateQueries({ queryKey: [k] });
  };
  const update = async (id: string, patch: Partial<Brand>) => {
    const { error } = await supabase.from('brands').update(patch).eq('id', id);
    if (error) notify('Not saved', error.code === '23505' ? 'Another company already has that name' : error.message);
    else refresh();
  };
  const rename = async (b: Brand) => {
    const name = (await askText('Rename company', `New name for "${b.name}"`))?.trim();
    if (name && name !== b.name) await update(b.id, { name });
  };
  const hide = async (b: Brand) => {
    if (await confirmAsk(`Hide ${b.name}?`, 'Its items stay in stock and history; the company just disappears from the company list.', 'Hide')) {
      await update(b.id, { is_active: false });
    }
  };
  const add = async () => {
    const name = (await askText('Add company', 'Company / brand name'))?.trim();
    if (!name) return;
    const { error } = await supabase.from('brands').insert({ name });
    if (error) notify('Company not added', error.code === '23505' ? `"${name}" already exists` : error.message);
    else refresh();
  };

  const active = (all.data ?? []).filter((b) => b.is_active);
  const hidden = (all.data ?? []).filter((b) => !b.is_active);
  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <ScrollView style={{ flex: 1, backgroundColor: t.surface }}
        contentContainerStyle={{ padding: 16, gap: 12, paddingTop: 40, width: '100%', maxWidth: 640, alignSelf: 'center' }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text style={{ flex: 1, color: t.text, fontSize: 20, fontWeight: '700' }}>Companies</Text>
          <SmallButton title="＋ Add" kind="primary" onPress={() => void add()} />
          <SmallButton title="Done" onPress={onClose} />
        </View>
        <Card>
          {active.map((b) => (
            <Row key={b.id} left={b.name} right={
              <View style={{ flexDirection: 'row', gap: 6 }}>
                <SmallButton title="Rename" onPress={() => void rename(b)} />
                <SmallButton title="Hide" onPress={() => void hide(b)} />
              </View>} />
          ))}
          {!active.length ? <Label muted>{all.isLoading ? 'Loading…' : 'No companies yet'}</Label> : null}
        </Card>
        {hidden.length ? (
          <Card title="Hidden companies">
            {hidden.map((b) => (
              <Row key={b.id} left={b.name} right={<SmallButton title="Show again" onPress={() => void update(b.id, { is_active: true })} />} />
            ))}
          </Card>
        ) : null}
      </ScrollView>
    </Modal>
  );
}
