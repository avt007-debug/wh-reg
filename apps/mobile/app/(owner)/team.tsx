/**
 * Owner settings: warehouses, staff logins (passwords, edit, reset, remove),
 * own Admin Override PIN, and WhatsApp delivery status.
 * Creating logins / passwords goes through the `admin-users` Edge Function
 * (Supabase Auth admin API never ships in the app).
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { rpc } from '../../src/api/client';
import { StaffAdmin } from '../../src/components/StaffAdmin';
import { Button, Card, Field, Label, Screen, Section, ThemeSwitch } from '../../src/components/ui';
import { WarehouseAdmin } from '../../src/components/WarehouseAdmin';
import { ReminderSettings } from '../../src/components/ReminderSettings';
import { notify } from '../../src/lib/dialogs';


export default function Settings() {
  const qc = useQueryClient();
  const [pin, setPin] = useState('');
  const savePin = useMutation({
    mutationFn: () => rpc('owner_set_override_pin', { p_pin: pin }),
    onSuccess: () => { setPin(''); void qc.invalidateQueries({ queryKey: ['users'] }); notify('Override PIN saved'); },
    onError: (e) => notify('Not saved', e instanceof Error ? e.message : String(e)),
  });

  return (
    <Screen>
      <Card title="Appearance" icon="color-palette-outline" subtitle="Day is bright for daylight; Night is dark and easy on the eyes. Auto follows your phone or computer.">
        <ThemeSwitch />
      </Card>
      <Section title="People & places" />
      <StaffAdmin />
      <WarehouseAdmin />
      <Section title="Security & alerts" />

      <Card title="My Admin Override PIN">
        <Label muted>Staff need this PIN to dispatch more than the physical stock. 6–8 digits.</Label>
        <Field label="New PIN" value={pin} onChangeText={setPin} keyboardType="number-pad" secureTextEntry maxLength={8} />
        <Button title="Save PIN" onPress={() => savePin.mutate()} busy={savePin.isPending} disabled={!/^\d{6,8}$/.test(pin)} />
      </Card>

      <ReminderSettings />
    </Screen>
  );
}
