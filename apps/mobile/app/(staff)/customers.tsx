/** Customers for employees: find a customer, call or WhatsApp, see what they owe, open their statement. */
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Linking, Text, View } from 'react-native';
import { formatINR } from '@wh/shared';
import { rpc } from '../../src/api/client';
import { StatementModal } from '../../src/components/Ledger';
import { Card, Chips, Field, Label, Screen, SmallButton, Toolbar } from '../../src/components/ui';
import { dmy } from '../../src/lib/dates';
import { openWhatsApp } from '../../src/lib/whatsapp';
import { useTheme } from '../../src/theme';

interface C { id: string; name: string; gstin: string | null; phone: string | null; address: string | null; is_dealer: boolean; balance: number; overdue: number;
  oldest_overdue_days: number | null; last_bill_date: string | null; last_payment_date: string | null }

export default function StaffCustomers() {
  const t = useTheme();
  const [search, setSearch] = useState(''); const [dq, setDq] = useState('');
  const [view, setView] = useState<'All' | 'Owes money' | 'Overdue'>('All');
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => { const id = setTimeout(() => setDq(search.trim()), 250); return () => clearTimeout(id); }, [search]);
  const q = useQuery({ queryKey: ['staff-customers', dq], queryFn: () => rpc<C[]>('staff_customers', { p_q: dq || null }) });
  const rows = (q.data ?? []).filter((c) => (view !== 'Owes money' || Number(c.balance) > 0) && (view !== 'Overdue' || Number(c.overdue) > 0));
  return (
    <Screen>
      <Field label="Search name, phone, GSTIN or place" value={search} onChangeText={setSearch} autoCapitalize="none" />
      <Chips options={['All', 'Owes money', 'Overdue'] as const} value={view} onChange={setView} />
      {rows.map((c) => (
        <Card key={c.id}>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <View style={{ flex: 1 }}>
              <Text style={{ color: t.text, fontWeight: '700', fontSize: 16 }}>{c.name}{c.is_dealer ? ' · dealer' : ''}</Text>
              <Label muted>{[c.phone ?? 'no phone', c.address, c.last_bill_date ? `last bill ${dmy(c.last_bill_date)}` : null].filter(Boolean).join(' · ')}</Label>
            </View>
            <View style={{ alignItems: 'flex-end' }}>
              <Text style={{ color: Number(c.balance) > 0 ? t.text : t.good, fontWeight: '800' }}>{formatINR(Number(c.balance))}</Text>
              {Number(c.overdue) > 0 ? <Text style={{ color: t.danger, fontSize: 12 }}>{formatINR(Number(c.overdue))} overdue</Text> : null}
            </View>
          </View>
          <Toolbar>
            {c.phone ? <SmallButton icon="call-outline" title="Call" onPress={() => void Linking.openURL(`tel:${c.phone}`)} /> : null}
            {c.phone ? <SmallButton icon="logo-whatsapp" title="WhatsApp" onPress={() => void openWhatsApp(c.phone, Number(c.balance) > 0
              ? `Namaste ${c.name}, a gentle reminder that ${formatINR(Number(c.balance))} is due. Kindly arrange the payment. Thank you.` : `Namaste ${c.name}, `)} /> : null}
            <SmallButton icon="document-text-outline" title="Statement" onPress={() => setOpen(c.id)} />
            {c.address ? <SmallButton icon="navigate-outline" title="Directions" onPress={() => void Linking.openURL(`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${c.name} ${c.address}`)}`)} /> : null}
          </Toolbar>
        </Card>
      ))}
      {!rows.length ? <Label muted>{q.isLoading ? 'Loading…' : 'No customers found'}</Label> : null}
      <StatementModal customerId={open} onClose={() => setOpen(null)} />
    </Screen>
  );
}
