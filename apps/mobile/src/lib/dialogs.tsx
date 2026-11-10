/**
 * Cross-platform dialogs. React Native's Alert does nothing on the web and
 * Alert.prompt is iOS-only, so screens use these helpers instead.
 */
import { useState } from 'react';
import { Alert, Modal, Platform, Text, TextInput, View } from 'react-native';
import { create } from 'zustand';
import { Button } from '../components/ui';
import { useTheme } from '../theme';

export function notify(title: string, message?: string) {
  if (Platform.OS === 'web') window.alert(message ? `${title}\n\n${message}` : title);
  else Alert.alert(title, message);
}

/** Yes/No question. Resolves true when confirmed. */
export function confirmAsk(title: string, message?: string, okLabel = 'OK'): Promise<boolean> {
  if (Platform.OS === 'web') return Promise.resolve(window.confirm(message ? `${title}\n\n${message}` : title));
  return new Promise((resolve) => Alert.alert(title, message, [
    { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
    { text: okLabel, style: 'destructive', onPress: () => resolve(true) },
  ], { cancelable: true, onDismiss: () => resolve(false) }));
}

interface PromptReq { title: string; message?: string; secure?: boolean; resolve: (v: string | null) => void }
const usePromptStore = create<{ req: PromptReq | null; set: (r: PromptReq | null) => void }>((set) => ({
  req: null, set: (req) => set({ req }),
}));

/** Ask for one line of text. Resolves null if cancelled. */
export function askText(title: string, message?: string, opts: { secure?: boolean } = {}): Promise<string | null> {
  if (Platform.OS === 'web') return Promise.resolve(window.prompt(message ? `${title}\n${message}` : title));
  return new Promise((resolve) => usePromptStore.getState().set({ title, message, secure: opts.secure, resolve }));
}

/** Mount once at the root (native only needs it, harmless on web). */
export function PromptHost() {
  const t = useTheme();
  const { req, set } = usePromptStore();
  const [value, setValue] = useState('');
  const close = (v: string | null) => { req?.resolve(v); set(null); setValue(''); };
  return (
    <Modal visible={!!req} transparent animationType="fade" onRequestClose={() => close(null)}>
      <View style={{ flex: 1, backgroundColor: '#0008', justifyContent: 'center', padding: 24 }}>
        <View style={{ backgroundColor: t.surface, borderRadius: 12, padding: 16, gap: 12 }}>
          <Text style={{ color: t.text, fontSize: 17, fontWeight: '700' }}>{req?.title}</Text>
          {req?.message ? <Text style={{ color: t.textSecondary }}>{req.message}</Text> : null}
          <TextInput autoFocus value={value} onChangeText={setValue} secureTextEntry={req?.secure}
            style={{ borderWidth: 1, borderColor: t.border, borderRadius: 10, padding: 12, color: t.text, fontSize: 16 }} />
          <Button title="OK" onPress={() => close(value)} disabled={!value.trim()} />
          <Button title="Cancel" kind="secondary" onPress={() => close(null)} />
        </View>
      </View>
    </Modal>
  );
}
