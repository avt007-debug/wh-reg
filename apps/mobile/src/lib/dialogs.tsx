/**
 * Cross-platform dialogs. React Native's Alert does nothing on the web and
 * Alert.prompt is iOS-only, so screens use these helpers instead.
 */
import { useState } from 'react';
import { Alert, Modal, Platform, Text, TextInput, View } from 'react-native';
import { create } from 'zustand';
import { Button } from '../components/ui';
import { useTheme } from '../theme';

/*
 * Browser pop-ups (window.alert / confirm / prompt) are silently blocked in many places —
 * home-screen web apps, WhatsApp / Instagram in-app browsers, some phone browsers — so
 * buttons that relied on them looked "dead". Every dialog is now drawn inside the app.
 */
type Kind = 'alert' | 'confirm' | 'prompt';
interface DialogReq { id: number; optional?: boolean; kind: Kind; title: string; message?: string; secure?: boolean; okLabel?: string; resolve: (v: string | boolean | null) => void }
let seq = 0;
const useDialogStore = create<{ queue: DialogReq[]; push: (r: Omit<DialogReq, 'id'>) => void; shift: () => void }>((set) => ({
  queue: [], push: (r) => set((s) => ({ queue: [...s.queue, { ...r, id: ++seq }] })), shift: () => set((s) => ({ queue: s.queue.slice(1) })),
}));

export function notify(title: string, message?: string) {
  if (Platform.OS !== 'web') { Alert.alert(title, message); return; }
  useDialogStore.getState().push({ kind: 'alert', title, message, resolve: () => undefined });
}

/** Yes/No question. Resolves true when confirmed. */
export function confirmAsk(title: string, message?: string, okLabel = 'OK'): Promise<boolean> {
  if (Platform.OS !== 'web') {
    return new Promise((resolve) => Alert.alert(title, message, [
      { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
      { text: okLabel, style: 'destructive', onPress: () => resolve(true) },
    ], { cancelable: true, onDismiss: () => resolve(false) }));
  }
  return new Promise((resolve) => useDialogStore.getState().push({ kind: 'confirm', title, message, okLabel, resolve: (v) => resolve(v === true) }));
}

/** Ask for one line of text. Resolves null if cancelled. */
export function askText(title: string, message?: string, opts: { secure?: boolean; optional?: boolean } = {}): Promise<string | null> {
  return new Promise((resolve) => useDialogStore.getState().push({
    kind: 'prompt', title, message, secure: opts.secure, optional: opts.optional, resolve: (v) => resolve(typeof v === 'string' ? v : null),
  }));
}

/** Mounted once at the root; shows queued dialogs one at a time. */
export function PromptHost() {
  const t = useTheme();
  const req = useDialogStore((s) => s.queue[0] ?? null);
  const shift = useDialogStore((s) => s.shift);
  const [value, setValue] = useState('');
  const close = (v: string | boolean | null) => { req?.resolve(v); shift(); setValue(''); };
  const cancel = () => close(req?.kind === 'confirm' ? false : null);
  return (
    <Modal visible={!!req} transparent animationType="fade" onRequestClose={cancel}>
      <View style={{ flex: 1, backgroundColor: t.overlay, justifyContent: 'center', padding: 24 }}>
        <View style={{ backgroundColor: t.card, borderRadius: 16, padding: 18, gap: 12, width: '100%', maxWidth: 440, alignSelf: 'center', borderWidth: 1, borderColor: t.border }}
          accessibilityRole="alert">
          <Text style={{ color: t.text, fontSize: 17, fontWeight: '800' }}>{req?.title}</Text>
          {req?.message ? <Text style={{ color: t.textSecondary, fontSize: 14.5 }}>{req.message}</Text> : null}
          {req?.kind === 'prompt' ? (
            <TextInput key={req.id} autoFocus value={value} onChangeText={setValue} secureTextEntry={req.secure} accessibilityLabel={req.title}
              onSubmitEditing={() => { if (value.trim() || req.optional) close(value); }} placeholderTextColor={t.textMuted}
              style={{ borderWidth: 1, borderColor: t.border, backgroundColor: t.cardAlt, borderRadius: 10, padding: 12, color: t.text, fontSize: 16 }} />
          ) : null}
          {req?.kind === 'alert' ? <Button title="OK" onPress={() => close(true)} /> : (
            <>
              <Button title={req?.kind === 'confirm' ? req.okLabel ?? 'OK' : 'OK'} kind={req?.kind === 'confirm' && req.okLabel && /delete|remove|reject/i.test(req.okLabel) ? 'danger' : 'primary'}
                onPress={() => close(req?.kind === 'confirm' ? true : value)} disabled={req?.kind === 'prompt' && !req.optional && !value.trim()} />
              <Button title="Cancel" kind="secondary" onPress={cancel} />
            </>
          )}
        </View>
      </View>
    </Modal>
  );
}
