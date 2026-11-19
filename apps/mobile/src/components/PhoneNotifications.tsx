/**
 * "Notifications on this phone" — turn on the clock-in / clock-out reminders (employees) and the
 * daily summary + alerts (owner) as normal phone notifications from the installed WH Reg app.
 * `compact` shows only a reminder banner while notifications are off (dashboard).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Platform, Text, View } from 'react-native';
import { rpc } from '../api/client';
import { notify } from '../lib/dialogs';
import { dateTimeIST } from '../lib/dates';
import { enablePush, isIOS, pushState, type PushState } from '../lib/push';
import { useTheme } from '../theme';
import { Button, Card, Label, Row, SmallButton } from './ui';

interface Status { ready: boolean; devices: { endpoint: string; device: string | null; since: string; last_ok_at: string | null; last_error: string | null }[] }

export function PhoneNotifications({ compact = false, what }: { compact?: boolean; what: string }) {
  const t = useTheme();
  const qc = useQueryClient();
  const [state, setState] = useState<PushState | null>(null);
  const status = useQuery({ queryKey: ['push-status'], queryFn: () => rpc<Status>('my_push_status'), enabled: Platform.OS === 'web' });
  useEffect(() => { void pushState().then(setState); }, []);

  const turnOn = useMutation({
    mutationFn: enablePush,
    onSuccess: (s) => {
      setState(s); void qc.invalidateQueries({ queryKey: ['push-status'] });
      if (s === 'on') void rpc('send_test_push');
      else if (s === 'denied') notify('Notifications are blocked', blockedHelp());
    },
    onError: (e) => notify('Could not turn on', e instanceof Error ? e.message : String(e)),
  });
  const test = useMutation({
    mutationFn: () => rpc('send_test_push'),
    onSuccess: () => notify('Test sent', 'A notification should appear on this phone within a few seconds.'),
    onError: (e) => notify('Not sent', e instanceof Error ? e.message : String(e)),
  });

  if (Platform.OS !== 'web' || state == null) return null;
  if (status.data && !status.data.ready) return null;               // not set up for this business yet
  if (compact && (state === 'on' || state === 'unsupported')) return null;

  const body = () => {
    if (state === 'on') return (
      <>
        <Row left="This phone" right="On ✓" sub={`You will get ${what} here.`} />
        <SmallButton icon="notifications-outline" title="Send me a test notification" onPress={() => test.mutate()} disabled={test.isPending} />
      </>
    );
    if (state === 'ios-needs-install') return (
      <Label>On iPhone: tap the Share button in Safari → "Add to Home Screen", then open WH Reg from that icon and turn notifications on there (needs iOS 16.4 or newer).</Label>
    );
    if (state === 'denied') return <Label>Notifications are blocked for this app. {blockedHelp()}</Label>;
    if (state === 'unsupported') return <Label>This browser cannot show notifications. Open WH Reg in Chrome (Android) or from the Home Screen icon (iPhone).</Label>;
    return (
      <>
        <Label>Get {what} as a normal phone notification — even when the app is closed.</Label>
        <Button title="Turn on notifications" onPress={() => turnOn.mutate()} busy={turnOn.isPending} />
      </>
    );
  };

  const others = (status.data?.devices ?? []).length;
  return (
    <Card title="Notifications on this phone" icon="notifications-outline" tone={state === 'on' ? 'good' : 'warning'}>
      {body()}
      {!compact && others ? (
        <View style={{ gap: 2 }}>
          <Text style={{ color: t.textMuted, fontSize: 12 }}>Turned on for you on {others} device(s):</Text>
          {status.data!.devices.map((d) => (
            <Text key={d.endpoint} style={{ color: t.textMuted, fontSize: 12 }}>
              • {d.device ?? 'Device'} · since {dateTimeIST(d.since)}{d.last_ok_at ? ` · last sent ${dateTimeIST(d.last_ok_at)}` : ''}{d.last_error ? ' · ⚠ last send failed' : ''}
            </Text>
          ))}
        </View>
      ) : null}
    </Card>
  );
}

function blockedHelp() {
  return isIOS()
    ? 'Open iPhone Settings → Notifications → WH Reg → Allow Notifications.'
    : 'Tap the lock / ⓘ icon next to the address (or long-press the app icon → App info) → Notifications → Allow, then come back here.';
}
