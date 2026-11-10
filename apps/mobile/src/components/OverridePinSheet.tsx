/**
 * Shown when a dispatch exceeds physical stock (API 409 INSUFFICIENT_STOCK).
 * The owner/admin types their PIN on the staff device (or reads it out); the
 * server returns a single-use, 10-minute override bound to this user + warehouse.
 */
import { useState } from 'react';
import { Modal, Text, View } from 'react-native';
import type { StockShortfall } from '@wh/shared';
import { api, ApiError } from '../api/client';
import { useTheme } from '../theme';
import { Button, Card, Field, Label, Row } from './ui';

export function OverridePinSheet({ shortfalls, onApproved, onCancel }: {
  shortfalls: StockShortfall[] | null; onApproved: (overrideId: string) => void; onCancel: () => void;
}) {
  const t = useTheme();
  const [pin, setPin] = useState('');
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true); setErr(null);
    try {
      const r = await api<{ overrideId: string }>('/overrides', { body: { pin, reason } });
      setPin(''); setReason('');
      onApproved(r.overrideId);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not verify PIN');
    } finally { setBusy(false); }
  }

  return (
    <Modal visible={!!shortfalls} transparent animationType="fade" onRequestClose={onCancel}>
      <View style={{ flex: 1, backgroundColor: '#0008', justifyContent: 'flex-end' }}>
        <View style={{ backgroundColor: t.surface, padding: 16, gap: 12, borderTopLeftRadius: 16, borderTopRightRadius: 16 }}>
          <Text style={{ color: t.text, fontSize: 18, fontWeight: '700' }}>⚠ Not enough stock</Text>
          <Card>
            {(shortfalls ?? []).map((s) => (
              <Row key={s.productId} left={s.productName} sub={`Requested ${s.requestedBase}`} right={`Available ${s.availableBase}`} />
            ))}
          </Card>
          <Label>An Owner/Admin PIN is required to dispatch beyond physical stock. This is logged.</Label>
          <Field label="Reason" value={reason} onChangeText={setReason} placeholder="e.g. stock arriving tomorrow" />
          <Field label="Admin Override PIN" value={pin} onChangeText={setPin} keyboardType="number-pad" secureTextEntry maxLength={8} error={err ?? undefined} />
          <Button title="Approve & dispatch" onPress={submit} busy={busy} disabled={pin.length < 6 || reason.trim().length < 3} />
          <Button title="Cancel" kind="secondary" onPress={onCancel} />
        </View>
      </View>
    </Modal>
  );
}
