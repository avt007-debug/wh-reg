/** Full-screen page that slides over the current one (forms, statements, details). */
import type { ReactNode } from 'react';
import { Modal, ScrollView, Text, View } from 'react-native';
import { useTheme } from '../theme';
import { pageBg, SmallButton } from './ui';

export function Sheet({ visible, title, subtitle, onClose, children, wide }: {
  visible: boolean; title: string; subtitle?: string; onClose: () => void; children: ReactNode; wide?: boolean;
}) {
  const t = useTheme();
  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <ScrollView style={[{ flex: 1 }, pageBg(t)]} keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ padding: 16, gap: 12, paddingTop: 36, paddingBottom: 60, width: '100%', maxWidth: wide ? 1000 : 760, alignSelf: 'center' }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <View style={{ flex: 1 }}>
            <Text style={{ color: t.text, fontSize: 20, fontWeight: '800' }}>{title}</Text>
            {subtitle ? <Text style={{ color: t.textSecondary }}>{subtitle}</Text> : null}
          </View>
          <SmallButton title="Close" onPress={onClose} />
        </View>
        {visible ? children : null}
      </ScrollView>
    </Modal>
  );
}
