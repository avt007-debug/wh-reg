/** Delivery proof: employee marks a bill delivered (receiver, photo and/or signature, location); owner views it. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { useEffect, useState } from 'react';
import { Linking, Text, View } from 'react-native';
import { fieldPhotoUrl, rpc, uploadFieldPhoto } from '../api/client';
import { useAuth } from '../auth/store';
import { dateTimeIST } from '../lib/dates';
import { notify } from '../lib/dialogs';
import { currentPosition, mapLink, type Position } from '../lib/location';
import { useTheme } from '../theme';
import { Sheet } from './Sheet';
import { SignaturePad } from './SignaturePad';
import { Button, Field, Label, SmallButton, Toolbar } from './ui';

interface Proof { dispatch_id: string; receiver_name: string; receiver_phone: string | null; photo_path: string | null; signature_path: string | null;
  lat: number | null; lng: number | null; accuracy_m: number | null; note: string | null; delivered_by_name: string; delivered_at: string }

export function MarkDeliveredSheet({ bill, onClose }: { bill: { id: string; invoice_no: string; customer_name: string } | null; onClose: () => void }) {
  const t = useTheme();
  const qc = useQueryClient();
  const uid = useAuth((s) => s.user?.id);
  const [name, setName] = useState(''); const [phone, setPhone] = useState(''); const [note, setNote] = useState('');
  const [photo, setPhoto] = useState<string | null>(null); const [sign, setSign] = useState<string | null>(null);
  const [pos, setPos] = useState<Position | null | 'asking'>(null);
  useEffect(() => {
    if (!bill) return;
    setName(''); setPhone(''); setNote(''); setPhoto(null); setSign(null); setPos('asking');
    void currentPosition().then(setPos);
  }, [bill]);
  const take = async () => {
    await ImagePicker.requestCameraPermissionsAsync();
    const r = await ImagePicker.launchCameraAsync({ quality: 0.5, mediaTypes: ['images'] });
    if (!r.canceled && r.assets[0]) setPhoto(r.assets[0].uri);
  };
  const save = useMutation({
    mutationFn: async () => {
      const p = pos && pos !== 'asking' ? pos : null;
      const photoPath = photo ? await uploadFieldPhoto(uid!, photo, 'delivery') : undefined;
      const signaturePath = sign ? await uploadFieldPhoto(uid!, sign, 'signature', 'image/png') : undefined;
      return rpc('mark_delivered', { p: { dispatchId: bill!.id, receiverName: name.trim(), receiverPhone: phone.trim() || undefined,
        photoPath, signaturePath, lat: p?.lat, lng: p?.lng, accuracy: p?.accuracy, note: note.trim() || undefined } });
    },
    onSuccess: () => { notify('Marked delivered', `${bill!.invoice_no} → ${name.trim()}`); void qc.invalidateQueries({ queryKey: ['my-bills'] }); void qc.invalidateQueries({ queryKey: ['delivered'] }); onClose(); },
    onError: (e) => notify('Not saved', e instanceof Error ? e.message : String(e)),
  });
  return (
    <Sheet visible={!!bill} title="Mark delivered" subtitle={bill ? `${bill.invoice_no} · ${bill.customer_name}` : ''} onClose={onClose}>
      <Field label="Received by (name)" value={name} onChangeText={setName} placeholder="e.g. Raju (shop owner)" />
      <Field label="Their phone (optional)" value={phone} onChangeText={setPhone} keyboardType="phone-pad" />
      <Button title={photo ? '✓ Photo taken — retake' : 'Photo of goods delivered'} icon="camera-outline" kind="secondary" onPress={() => void take()} />
      {photo ? <Image source={{ uri: photo }} style={{ width: '100%', height: 200, borderRadius: 10 }} contentFit="cover" /> : null}
      <Label>Signature</Label>
      {bill ? <SignaturePad onChange={setSign} /> : null}
      <Field label="Note (optional)" value={note} onChangeText={setNote} placeholder="e.g. 2 boxes short, will send tomorrow" />
      <Label muted>{pos === 'asking' ? 'Getting location…' : pos ? `Location saved (±${pos.accuracy} m)` : 'Location not available — allow location to record where it was delivered.'}</Label>
      <Button title="Save delivery proof" icon="checkmark-done-outline" onPress={() => save.mutate()} busy={save.isPending}
        disabled={name.trim().length < 2 || (!photo && !sign) || !uid} />
      <Text style={{ color: t.textMuted, fontSize: 12 }}>A photo or a signature is needed. Both are best.</Text>
    </Sheet>
  );
}

export function DeliveryProofView({ dispatchId, summary }: { dispatchId: string; summary: string }) {
  const t = useTheme();
  const [open, setOpen] = useState(false);
  const info = useQuery({ queryKey: ['delivery', dispatchId], enabled: open, queryFn: async () => {
    const p = await rpc<Proof | null>('delivery_info', { p_dispatch: dispatchId });
    return { p, photo: p?.photo_path ? await fieldPhotoUrl(p.photo_path) : null, sign: p?.signature_path ? await fieldPhotoUrl(p.signature_path) : null };
  } });
  return (
    <View style={{ gap: 6 }}>
      <Toolbar>
        <Text style={{ color: t.good, fontWeight: '700', flexShrink: 1 }}>✓ {summary}</Text>
        <SmallButton title={open ? 'Hide proof' : 'See proof'} onPress={() => setOpen((v) => !v)} />
      </Toolbar>
      {open && info.data?.p ? (
        <View style={{ gap: 6 }}>
          {info.data.p.receiver_phone ? <Label muted>Receiver phone {info.data.p.receiver_phone}</Label> : null}
          {info.data.p.note ? <Label muted>Note: {info.data.p.note}</Label> : null}
          <Label muted>Delivered {dateTimeIST(info.data.p.delivered_at)} by {info.data.p.delivered_by_name}</Label>
          {info.data.p.lat != null ? <SmallButton icon="location-outline" title="Open location in Maps" onPress={() => void Linking.openURL(mapLink(Number(info.data!.p!.lat), Number(info.data!.p!.lng)))} /> : null}
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
            {info.data.photo ? <Image source={{ uri: info.data.photo }} style={{ width: 220, height: 160, borderRadius: 8 }} contentFit="cover" /> : null}
            {info.data.sign ? <Image source={{ uri: info.data.sign }} style={{ width: 220, height: 110, borderRadius: 8, backgroundColor: '#fff' }} contentFit="contain" /> : null}
          </View>
        </View>
      ) : open ? <Label muted>Loading…</Label> : null}
    </View>
  );
}
