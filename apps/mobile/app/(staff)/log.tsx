import { useQuery } from '@tanstack/react-query';
import { formatINR } from '@wh/shared';
import { rpc } from '../../src/api/client';
import { useAuth } from '../../src/auth/store';
import { Button, Card, Label, Row, Screen, ThemeSwitch } from '../../src/components/ui';

/** "My Day": the employee's own entries from today (that is all RLS returns to them). */
export default function MyDay() {
  const logout = useAuth((s) => s.signOut);
  const q = useQuery({
    queryKey: ['my-day'],
    queryFn: () => rpc<{
      dispatches: { id: string; invoice_no: string; customer_name: string; grand_total: number; used_override: boolean }[];
      purchases: { id: string; vendor_name: string; vendor_invoice_no: string; grand_total: number; status: string }[];
    }>('my_day'),
  });
  return (
    <Screen>
      <Card title={`Sales today (${q.data?.dispatches.length ?? 0})`}>
        {q.data?.dispatches.map((d) => (
          <Row key={d.id} left={d.invoice_no} sub={`${d.customer_name}${d.used_override ? ' · override' : ''}`} right={formatINR(d.grand_total)} />
        ))}
      </Card>
      <Card title={`Purchases today (${q.data?.purchases.length ?? 0})`}>
        {q.data?.purchases.map((p) => <Row key={p.id} left={p.vendor_name} right={formatINR(p.grand_total)}
          sub={`${p.vendor_invoice_no} · ${p.status === 'PENDING' ? '⏳ waiting for owner approval' : p.status === 'POSTED' ? '✓ approved, added to stock' : '✕ rejected'}`} />)}
      </Card>
      <Label muted>Entries are locked once saved. Ask the owner to cancel a wrong entry, then re-enter it.</Label>
      <Card title="Appearance" icon="color-palette-outline" subtitle="Day, Auto (follows your phone) or Night"><ThemeSwitch /></Card>
      <Button title="Log out" icon="log-out-outline" kind="secondary" onPress={() => void logout()} />
    </Screen>
  );
}
