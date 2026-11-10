import { Text, View } from 'react-native';
import { dmy } from '../lib/dates';
import { useTheme } from '../theme';

export interface Visit { id: string; visit_date: string; customer_name: string; shop_name: string | null; phone: string | null; place: string | null; outcome: string; notes: string | null; created_at?: string }
export const OUTCOMES = ['ORDER', 'INTERESTED', 'FOLLOW_UP', 'NOT_INTERESTED'] as const;
export const OUTCOME: Record<string, string> = { ORDER: '✓ Order', INTERESTED: 'Interested', FOLLOW_UP: 'Follow up', NOT_INTERESTED: 'Not interested' };

export function VisitRow({ v, showDate }: { v: Visit; showDate?: boolean }) {
  const t = useTheme();
  return (
    <View style={{ paddingVertical: 6, borderBottomWidth: 0.5, borderColor: t.border }}>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Text style={{ flex: 1, color: t.text, fontWeight: '600' }}>{v.customer_name}{v.shop_name ? ` · ${v.shop_name}` : ''}</Text>
        <Text style={{ color: v.outcome === 'ORDER' ? t.good : v.outcome === 'NOT_INTERESTED' ? t.textMuted : t.warning, fontWeight: '600' }}>{OUTCOME[v.outcome] ?? v.outcome}</Text>
      </View>
      <Text style={{ color: t.textMuted, fontSize: 12 }}>
        {[showDate ? dmy(v.visit_date) : null, v.place, v.phone, v.notes].filter(Boolean).join(' · ')}
      </Text>
    </View>
  );
}
