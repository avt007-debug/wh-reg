/** Business details printed on every invoice: name, address, phone, bank / UPI, terms. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { rpc } from '../api/client';
import { notify } from '../lib/dialogs';
import { Button, Card, Field, Label } from './ui';

type Biz = Record<string, string | number | null>;
const KEYS = ['name', 'address', 'phone', 'email', 'bank_name', 'bank_account', 'bank_ifsc', 'upi_id', 'terms'] as const;

export function BusinessProfile() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['business-settings'], queryFn: () => rpc<Biz>('owner_business_settings') });
  const [f, setF] = useState<Record<string, string>>({});
  useEffect(() => { if (q.data) setF(Object.fromEntries(KEYS.map((k) => [k, String(q.data![k] ?? '')]))); }, [q.data]);
  const set = (k: string) => (v: string) => setF((s) => ({ ...s, [k]: v }));
  const save = useMutation({
    mutationFn: () => rpc('owner_save_business', { p: { ...(q.data ?? {}), ...f } }),
    onSuccess: () => { notify('Saved', 'New invoices will show these details.'); void qc.invalidateQueries({ queryKey: ['business-settings'] }); },
    onError: (e) => notify('Not saved', e instanceof Error ? e.message : String(e)),
  });
  return (
    <Card title="Business details on invoices" icon="business-outline" subtitle="Printed on every bill and in the WhatsApp bill message. GSTIN and address per warehouse are under Warehouses.">
      <Field label="Business name" value={f.name ?? ''} onChangeText={set('name')} placeholder="e.g. Sri Vinayaka Agencies" />
      <Field label="Head office address" value={f.address ?? ''} onChangeText={set('address')} multiline />
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Field label="Phone" value={f.phone ?? ''} onChangeText={set('phone')} keyboardType="phone-pad" />
        <Field label="Email" value={f.email ?? ''} onChangeText={set('email')} autoCapitalize="none" keyboardType="email-address" />
      </View>
      <Label>Bank details (so customers can pay)</Label>
      <Field label="Bank name" value={f.bank_name ?? ''} onChangeText={set('bank_name')} />
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Field label="Account no." value={f.bank_account ?? ''} onChangeText={set('bank_account')} keyboardType="number-pad" />
        <Field label="IFSC" value={f.bank_ifsc ?? ''} onChangeText={(v) => set('bank_ifsc')(v.toUpperCase())} autoCapitalize="characters" maxLength={11} />
      </View>
      <Field label="UPI ID" value={f.upi_id ?? ''} onChangeText={set('upi_id')} autoCapitalize="none" placeholder="e.g. vinayaka@sbi" />
      <Field label="Terms printed at the bottom of bills" value={f.terms ?? ''} onChangeText={set('terms')} multiline />
      <Button title="Save business details" onPress={() => save.mutate()} busy={save.isPending} disabled={!q.data} />
    </Card>
  );
}
