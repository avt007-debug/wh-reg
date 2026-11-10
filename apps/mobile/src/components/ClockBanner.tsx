/** Reminds staff to clock in; one tap clocks them in. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Text, View } from 'react-native';
import { rpc } from '../api/client';
import { timeIST } from '../lib/dates';
import { notify } from '../lib/dialogs';
import { useTheme } from '../theme';
import { SmallButton } from './ui';

export function ClockBanner() {
  const t = useTheme();
  const qc = useQueryClient();
  const att = useQuery({ queryKey: ['my-attendance'], queryFn: () => rpc<{ open: { clock_in_at: string } | null }>('my_attendance') });
  const clockIn = useMutation({
    mutationFn: () => rpc<{ clock_in_at: string }>('clock_in'),
    onSuccess: (s) => { void qc.invalidateQueries({ queryKey: ['my-attendance'] }); notify('Clocked in', `at ${timeIST(s.clock_in_at)}`); },
    onError: (e) => notify('Not clocked in', e instanceof Error ? e.message : String(e)),
  });
  if (att.isLoading || att.isError) return null;
  const open = att.data?.open;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, padding: 10, borderRadius: 10, borderWidth: 1,
      borderColor: open ? t.border : t.warning, backgroundColor: t.card }}>
      <Text style={{ flex: 1, color: open ? t.textSecondary : t.warning, fontWeight: '600' }}>
        {open ? `🟢 Clocked in since ${timeIST(open.clock_in_at)}` : 'You have not clocked in'}
      </Text>
      {!open ? <SmallButton title="Clock in" kind="primary" onPress={() => clockIn.mutate()} disabled={clockIn.isPending} /> : null}
    </View>
  );
}
