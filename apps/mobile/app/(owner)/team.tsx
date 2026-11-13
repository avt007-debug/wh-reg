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
import { MyAccount } from '../../src/components/MyAccount';
import { LoginSecurity, RecoveryCodes } from '../../src/components/LoginSecurity';
import { notify } from '../../src/lib/dialogs';
import { BusinessProfile } from '../../src/components/BusinessProfile';
import { ExportAll } from '../../src/components/ExportAll';
import { TextSize } from '../../src/components/TextSize';
import { useAuth } from '../../src/auth/store';


export default function Settings() {
  const manager = useAuth((s) => s.user?.role) === 'ADMIN';

  return (
    <Screen>
      <MyAccount />
      <Card title="Appearance" icon="color-palette-outline" subtitle="Day is bright for daylight; Night is dark and easy on the eyes. Auto follows your phone or computer.">
        <ThemeSwitch />
      </Card>
      <TextSize />
      {manager ? (
        <Card title="Manager login" icon="shield-half-outline">
          <Label muted>You are logged in as a manager. Staff logins, passwords, security, WhatsApp reminders, prices, targets and profit & loss are handled by the owner.</Label>
        </Card>
      ) : <ManagerOnlyHidden />}
    </Screen>
  );
}

function ManagerOnlyHidden() {
  const qc = useQueryClient();
  const [pin, setPin] = useState('');
  const savePin = useMutation({
    mutationFn: () => rpc('owner_set_override_pin', { p_pin: pin }),
    onSuccess: () => { setPin(''); void qc.invalidateQueries({ queryKey: ['users'] }); notify('Override PIN saved'); },
    onError: (e) => notify('Not saved', e instanceof Error ? e.message : String(e)),
  });
  return (
    <>
      <BusinessProfile />
      <ExportAll />
      <Section title="People & places" />
      <StaffAdmin />
      <WarehouseAdmin />
      <Section title="Security & alerts" />
      <LoginSecurity />
      <RecoveryCodes />

      <Card title="My Admin Override PIN">
        <Label muted>Staff need this PIN to dispatch more than the physical stock. 6–8 digits.</Label>
        <Field label="New PIN" value={pin} onChangeText={setPin} keyboardType="number-pad" secureTextEntry maxLength={8} />
        <Button title="Save PIN" onPress={() => savePin.mutate()} busy={savePin.isPending} disabled={!/^\d{6,8}$/.test(pin)} />
      </Card>

      <ReminderSettings />
    </>
  );
}
