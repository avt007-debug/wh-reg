/** Owner: add a warehouse or edit one (name, short code, state, address, GSTIN, active). */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { gstinStateCode, isValidGstin, STATE_CODES } from '@wh/shared';
import type { Warehouse } from '../api/types';
import { notify } from '../lib/dialogs';
import { supabase } from '../lib/supabase';
import { useWarehouses } from '../lib/warehouse';
import { Button, Card, Field, Label, Row, SmallButton, Toolbar } from './ui';

type Draft = { id?: string; name: string; code: string; state_code: string; address: string; gstin: string; is_active: boolean };
const blank: Draft = { name: '', code: '', state_code: '37', address: '', gstin: '', is_active: true };

export function WarehouseAdmin() {
  const qc = useQueryClient();
  const whs = useWarehouses(true);
  const [d, setD] = useState<Draft | null>(null);

  const codeOk = !!d && /^[A-Z0-9]{2,4}$/.test(d.code);
  const stateOk = !!d && /^\d{2}$/.test(d.state_code) && !!STATE_CODES[d.state_code];
  const gstin = d?.gstin.trim().toUpperCase() ?? '';
  const gstinErr = !gstin ? undefined : !isValidGstin(gstin) ? 'Not a valid GSTIN'
    : gstinStateCode(gstin) !== d?.state_code ? `GSTIN is for state ${gstinStateCode(gstin)}, warehouse state is ${d?.state_code}` : undefined;

  const save = useMutation({
    mutationFn: async () => {
      const row = { name: d!.name.trim(), code: d!.code, state_code: d!.state_code, address: d!.address.trim() || null, gstin: gstin || null, is_active: d!.is_active };
      const res = d!.id
        ? await supabase.from('warehouses').update({ ...row, updated_at: new Date().toISOString() }).eq('id', d!.id)
        : await supabase.from('warehouses').insert(row);
      if (res.error) throw new Error(res.error.code === '23505' ? `Code ${row.code} is already used by another warehouse` : res.error.message);
    },
    onSuccess: () => {
      notify(d?.id ? 'Warehouse updated' : 'Warehouse added', d?.id ? undefined : 'It now appears in every warehouse switch. Add staff for it below.');
      setD(null);
      void qc.invalidateQueries({ queryKey: ['warehouses'] });
      void qc.invalidateQueries({ queryKey: ['stock-overview'] });
    },
    onError: (e) => notify('Not saved', e instanceof Error ? e.message : String(e)),
  });

  const edit = (w: Warehouse) => setD({
    id: w.id, name: w.name, code: w.code, state_code: w.state_code, address: w.address ?? '', gstin: w.gstin ?? '', is_active: w.is_active !== false,
  });

  return (
    <Card title="Warehouses">
      {(whs.data ?? []).map((w) => (
        <Row key={w.id} left={`${w.name} (${w.code})${w.is_active === false ? ' · closed' : ''}`}
          sub={[STATE_CODES[w.state_code] ?? w.state_code, w.address, w.gstin ? `GSTIN ${w.gstin}` : 'GSTIN not set'].filter(Boolean).join(' · ')}
          right={<SmallButton title="Edit" onPress={() => edit(w)} />} />
      ))}
      {!d ? <Button title="＋ Add warehouse" kind="secondary" onPress={() => setD({ ...blank })} /> : (
        <>
          <Label>{d.id ? `Editing ${d.name}` : 'New warehouse'}</Label>
          <Field label="Name" value={d.name} onChangeText={(v) => setD({ ...d, name: v })} placeholder="e.g. Tirupati" />
          <Field label="Short code (2–4 letters, printed on invoice numbers)" value={d.code} autoCapitalize="characters" maxLength={4}
            onChangeText={(v) => setD({ ...d, code: v.toUpperCase().replace(/[^A-Z0-9]/g, '') })}
            error={d.code && !codeOk ? '2–4 letters/digits' : undefined} />
          {d.id ? <Label muted>Changing the code only affects new invoices; old invoice numbers stay as they are.</Label> : null}
          <Field label={`State code${stateOk ? ` — ${STATE_CODES[d.state_code]}` : ''}`} value={d.state_code} keyboardType="number-pad" maxLength={2}
            onChangeText={(v) => setD({ ...d, state_code: v.replace(/\D/g, '') })} error={d.state_code && !stateOk ? 'Unknown state code (37 = Andhra Pradesh)' : undefined} />
          <Field label="Address" value={d.address} onChangeText={(v) => setD({ ...d, address: v })} />
          <Field label="GSTIN (optional)" value={d.gstin} autoCapitalize="characters" maxLength={15}
            onChangeText={(v) => setD({ ...d, gstin: v.toUpperCase() })} error={gstinErr} />
          {d.id ? (
            <Toolbar>
              <SmallButton title={d.is_active ? 'Open (tap to close)' : 'Closed (tap to reopen)'} onPress={() => setD({ ...d, is_active: !d.is_active })} />
            </Toolbar>
          ) : null}
          <Button title={d.id ? 'Save warehouse' : 'Add warehouse'} onPress={() => save.mutate()} busy={save.isPending}
            disabled={!d.name.trim() || !codeOk || !stateOk || !!gstinErr} />
          <Button title="Cancel" kind="secondary" onPress={() => setD(null)} />
        </>
      )}
    </Card>
  );
}
