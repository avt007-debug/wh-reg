/**
 * Bell in every page header: reminders (clock in / clock out), the owner's daily summary,
 * purchase approvals, leave decisions … Everything that is sent on WhatsApp also lands here.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Modal, Pressable, ScrollView, Text, View } from 'react-native';
import { rpc } from '../api/client';
import { isOwner, useAuth } from '../auth/store';
import { dateTimeIST } from '../lib/dates';
import { useTheme } from '../theme';
import { Empty, glass, SmallButton, type IconName } from './ui';

export interface Note { id: number; kind: string; title: string; body: string; data: Record<string, unknown>; created_at: string; read_at: string | null }

const ICON: Record<string, IconName> = {
  CLOCK_IN_REMINDER: 'alarm-outline', CLOCK_OUT_REMINDER: 'exit-outline', DAILY_SUMMARY: 'stats-chart-outline',
  PURCHASE_APPROVED: 'checkmark-circle-outline', PURCHASE_REJECTED: 'close-circle-outline', PURCHASE_PENDING: 'hourglass-outline',
  LEAVE: 'calendar-outline', REQUEST: 'help-buoy-outline', MESSAGE: 'chatbubble-ellipses-outline', LOGIN_ALERT: 'shield-outline',
  TARGET: 'flag-outline', DELIVERY: 'car-outline',
};

/** Where tapping a notification takes the person. */
function target(kind: string, owner: boolean): string | null {
  if (kind === 'CLOCK_IN_REMINDER' || kind === 'CLOCK_OUT_REMINDER') return '/work';
  if (kind === 'DAILY_SUMMARY') return owner ? '/report' : null;
  if (kind.startsWith('PURCHASE')) return owner ? '/purchases' : '/log';
  if (kind === 'LEAVE' || kind === 'REQUEST') return owner ? '/employees' : '/work';
  if (kind === 'LOGIN_ALERT') return owner ? '/team' : null;
  if (kind === 'TARGET') return owner ? '/employees' : '/home';
  return null;
}

export function NotificationBell() {
  const t = useTheme();
  const qc = useQueryClient();
  const router = useRouter();
  const owner = isOwner(useAuth((s) => s.user));
  const [open, setOpen] = useState(false);
  const q = useQuery({ queryKey: ['notifications'], queryFn: () => rpc<{ unread: number; items: Note[] }>('my_notifications', { p_limit: 60 }), refetchInterval: 60_000 });
  const read = useMutation({
    mutationFn: (ids: number[] | null) => rpc<number>('mark_notifications_read', { p_ids: ids }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['notifications'] }),
  });
  const unread = Number(q.data?.unread ?? 0);
  const items = q.data?.items ?? [];

  return (
    <>
      <Pressable onPress={() => setOpen(true)} accessibilityLabel={`Notifications${unread ? `, ${unread} unread` : ''}`}
        style={({ pressed }) => ({ width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: pressed ? t.cardAlt : 'transparent' })}>
        <Ionicons name={unread ? 'notifications' : 'notifications-outline'} size={21} color={unread ? t.accent : t.text} />
        {unread ? (
          <View style={{ position: 'absolute', top: 4, right: 3, minWidth: 18, height: 18, borderRadius: 9, backgroundColor: t.accent, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4, borderWidth: 1.5, borderColor: t.yellow }}>
            <Text style={{ color: '#fff', fontSize: 10, fontWeight: '800' }}>{unread > 99 ? '99+' : unread}</Text>
          </View>
        ) : null}
      </Pressable>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={{ flex: 1, backgroundColor: t.overlay }} onPress={() => setOpen(false)} />
        <View style={[{ position: 'absolute', top: 60, right: 12, left: 12, maxWidth: 440, marginLeft: 'auto', maxHeight: '80%', borderRadius: 18,
          backgroundColor: t.dark ? 'rgba(30,12,14,0.92)' : 'rgba(255,255,255,0.94)', borderWidth: 1, borderColor: t.border, padding: 14, gap: 10 }, glass(t, 28)]}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Text style={{ flex: 1, color: t.text, fontSize: 17, fontWeight: '800' }}>Notifications</Text>
            {unread ? <SmallButton title="Mark all read" icon="checkmark-done-outline" onPress={() => read.mutate(null)} /> : null}
            <SmallButton title="Close" onPress={() => setOpen(false)} />
          </View>
          <ScrollView contentContainerStyle={{ gap: 6 }}>
            {items.map((n) => {
              const to = target(n.kind, owner);
              return (
                <Pressable key={n.id} onPress={() => { if (!n.read_at) read.mutate([n.id]); if (to) { setOpen(false); router.navigate(to as never); } }}
                  style={({ pressed }) => ({ flexDirection: 'row', gap: 10, padding: 10, borderRadius: 12, borderWidth: 1,
                    borderColor: n.read_at ? t.hairline : t.accent, backgroundColor: pressed ? t.accentSoft : n.read_at ? 'transparent' : t.accentSoft })}>
                  <Ionicons name={ICON[n.kind] ?? 'notifications-outline'} size={20} color={t.accent} />
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text style={{ color: t.text, fontWeight: n.read_at ? '600' : '800' }}>{n.title}</Text>
                    <Text style={{ color: t.textSecondary, fontSize: 13 }}>{n.body}</Text>
                    <Text style={{ color: t.textMuted, fontSize: 11.5 }}>{dateTimeIST(n.created_at)}</Text>
                  </View>
                </Pressable>
              );
            })}
            {!items.length ? <Empty icon="notifications-off-outline" text={q.isLoading ? 'Loading…' : 'No notifications yet'} /> : null}
          </ScrollView>
        </View>
      </Modal>
    </>
  );
}
