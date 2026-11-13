/** Banner + background sender for bills saved while offline. */
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { Text, View } from 'react-native';
import { rpc } from '../api/client';
import { useAuth } from '../auth/store';
import { confirmAsk, notify } from '../lib/dialogs';
import { isOffline, useOutbox } from '../lib/outbox';
import { useTheme } from '../theme';
import { SmallButton } from './ui';

export function OfflineQueue() {
  const t = useTheme();
  const qc = useQueryClient();
  const user = useAuth((s) => s.user);
  const { items, remove, fail, retry } = useOutbox();
  const busy = useRef(false);
  const flush = async () => {
    if (busy.current || !user) return;
    busy.current = true;
    try {
      for (const b of useOutbox.getState().items.filter((x) => !x.error)) {
        try {
          await rpc(b.fn, b.args);
          remove(b.id);
          notify('Sent', `${b.label} reached the server.`);
          for (const k of ['my-day', 'my-bills', 'inventory', 'sales-month', 'purchases-month', 'my-dashboard', 'owner-ledger', 'my-ledger']) void qc.invalidateQueries({ queryKey: [k] });
        } catch (e) {
          if (isOffline(e)) break;
          fail(b.id, e instanceof Error ? e.message : String(e));
        }
      }
    } finally { busy.current = false; }
  };
  useEffect(() => {
    if (!user) return;
    void flush();
    const id = setInterval(() => void flush(), 30_000);
    const on = () => void flush();
    globalThis.addEventListener?.('online', on);
    return () => { clearInterval(id); globalThis.removeEventListener?.('online', on); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);
  if (!user || !items.length) return null;
  const waiting = items.filter((x) => !x.error);
  const failed = items.filter((x) => x.error);
  return (
    <View style={{ position: 'absolute', top: 8, left: 8, right: 8, alignItems: 'center' }} pointerEvents="box-none">
      <View style={{ backgroundColor: failed.length ? t.danger : t.yellow, borderRadius: 14, padding: 10, gap: 6, maxWidth: 560, width: '100%' }}>
        {waiting.length ? <Text style={{ color: '#111', fontWeight: '800' }}>📶 {waiting.length} saved on this phone — will send when internet is back</Text> : null}
        {failed.map((b) => (
          <View key={b.id} style={{ gap: 4 }}>
            <Text style={{ color: '#fff', fontWeight: '800' }}>Could not send {b.label}: {b.error}</Text>
            <View style={{ flexDirection: 'row', gap: 6 }}>
              <SmallButton title="Try again" onPress={() => { retry(b.id); void flush(); }} />
              <SmallButton title="Discard" kind="danger" onPress={() => void confirmAsk('Discard this bill?', 'It was never saved on the server.', 'Discard').then((ok) => ok && remove(b.id))} />
            </View>
          </View>
        ))}
        {waiting.length ? <SmallButton title="Send now" onPress={() => void flush()} /> : null}
      </View>
    </View>
  );
}
