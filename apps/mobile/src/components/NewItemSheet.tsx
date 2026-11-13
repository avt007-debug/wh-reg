/**
 * Add a new item while making a sale or purchase (owner and employees).
 * Also lets them add a new company or category on the spot.
 * Details: item code, name, company, category, HSN, GST %, price per piece (excl. GST),
 * std packing (pcs per pack) and MOQ (pcs per carton). The saved item goes straight onto the bill.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Modal, ScrollView, Text, View } from 'react-native';
import { formatINR } from '@wh/shared';
import { q, rpc } from '../api/client';
import type { ProductHit } from '../api/types';
import { notify } from '../lib/dialogs';
import { supabase } from '../lib/supabase';
import { useTheme } from '../theme';
import { Button, Card, Chips, Field, Label, Notice, SmallButton, pageBg } from './ui';

const UNITS = ['PCS', 'SET', 'PAIR', 'MTR', 'KG', 'LTR', 'ROLL', 'BOX'] as const;
const NEW = '__new';

export function NewItemSheet({ visible, initialCode, onClose, onCreated, forPurchase }: {
  forPurchase?: boolean; visible: boolean; initialCode?: string; onClose: () => void; onCreated: (p: ProductHit) => void;
}) {
  const t = useTheme();
  const qc = useQueryClient();
  const brands = useQuery({ queryKey: ['brands'], enabled: visible, queryFn: () => q<{ id: string; name: string }[]>(supabase.from('brands').select('id, name').eq('is_active', true).order('name')) });
  const tree = useQuery({ queryKey: ['catalog-tree'], enabled: visible, staleTime: 600_000, queryFn: () => rpc<{ categories: { id: string; path: string }[] }>('catalog_tree') });
  const slabs = useQuery({ queryKey: ['gst'], staleTime: 3600_000, queryFn: () => q<{ rate: number }[]>(supabase.from('gst_rates').select('rate').eq('is_active', true).order('rate')) });

  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [brandId, setBrandId] = useState('');
  const [newBrand, setNewBrand] = useState('');
  const [catId, setCatId] = useState('');
  const [newCat, setNewCat] = useState('');
  const [catParent, setCatParent] = useState('');
  const [spec, setSpec] = useState('');
  const [hsn, setHsn] = useState('');
  const [gst, setGst] = useState<number | null>(18);
  const [price, setPrice] = useState('');
  const [unit, setUnit] = useState<string>('PCS');
  const [pkg, setPkg] = useState('');
  const [moq, setMoq] = useState('');

  useEffect(() => {
    if (!visible) return;
    setCode((initialCode ?? '').toUpperCase()); setName(''); setBrandId(''); setNewBrand(''); setCatId(''); setNewCat(''); setCatParent('');
    setSpec(''); setHsn(''); setGst(18); setPrice(''); setUnit('PCS'); setPkg(''); setMoq('');
  }, [visible, initialCode]);

  const fail = (e: unknown) => notify('Not saved', e instanceof Error ? e.message : String(e));
  const addBrand = useMutation({
    mutationFn: () => rpc<{ id: string; name: string; created: boolean }>('add_company', { p_name: newBrand }),
    onSuccess: (b) => { setBrandId(b.id); setNewBrand(''); void qc.invalidateQueries({ queryKey: ['brands'] }); void qc.invalidateQueries({ queryKey: ['catalog-tree'] });
      notify(b.created ? 'Company added' : 'Company already exists — selected it', b.name); },
    onError: fail,
  });
  const addCat = useMutation({
    mutationFn: () => rpc<{ id: string; path: string; created: boolean }>('add_category', { p_name: newCat, p_parent: catParent || null }),
    onSuccess: (c) => { void qc.invalidateQueries({ queryKey: ['catalog-tree'] }); setCatId(c.id); setNewCat(''); setCatParent('');
      notify(c.created ? 'Category added' : 'Category already exists — selected it', c.path); },
    onError: fail,
  });

  const codeOk = /^[A-Z0-9][A-Z0-9_./-]{1,31}$/.test(code.trim());
  const hsnOk = /^[0-9]{4}([0-9]{2}){0,2}$/.test(hsn.trim());
  const whole = (s: string) => s.trim() === '' || (/^\d+$/.test(s.trim()) && Number(s) >= 1);
  const priceOk = price.trim() === '' || (Number.isFinite(Number(price)) && Number(price) >= 0);
  const valid = codeOk && name.trim().length >= 2 && hsnOk && gst != null && priceOk && whole(pkg) && whole(moq) && brandId !== NEW && catId !== NEW;

  const save = useMutation({
    mutationFn: () => rpc<ProductHit>('create_item', {
      p: {
        skuCode: code.trim(), name: name.trim(), brandId: brandId || null, categoryId: catId || null, specification: spec.trim(),
        hsnCode: hsn.trim(), gstRate: gst, sellingPrice: price.trim() === '' ? null : Number(price), baseUom: unit,
        stdPkg: pkg.trim() === '' ? null : Number(pkg), moq: moq.trim() === '' ? null : Number(moq),
      },
    }),
    onSuccess: (p) => {
      for (const k of ['material', 'search', 'owner-stock', 'catalog-tree']) void qc.invalidateQueries({ queryKey: [k] });
      notify('Item added', `${p.sku_code} · ${p.name} is now on this bill`);
      onCreated(p); onClose();
    },
    onError: fail,
  });

  const cats = tree.data?.categories ?? [];
  const incl = Number(price) > 0 && gst != null ? Math.round(Number(price) * (100 + gst)) / 100 : null;

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <ScrollView style={[{ flex: 1 }, pageBg(t)]} keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ padding: 16, gap: 12, paddingTop: 40, width: '100%', maxWidth: 760, alignSelf: 'center' }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <View style={{ flex: 1 }}>
            <Text style={{ color: t.text, fontSize: 20, fontWeight: '800' }}>New item</Text>
            <Text style={{ color: t.textMuted }}>Saved for everyone and added to this bill</Text>
          </View>
          <SmallButton title="Close" onPress={onClose} />
        </View>

        <Card title="Item" icon="cube-outline">
          <Field label="Item code / Material No." value={code} autoCapitalize="characters" onChangeText={(v) => setCode(v.toUpperCase().replace(/\s/g, ''))}
            placeholder="e.g. JKF-200" error={code && !codeOk ? '2–32 letters, digits or - _ . /' : undefined} />
          <Field label="Item name / description" value={name} onChangeText={setName} placeholder="e.g. Flat File 200mm" />
          <Field label="Size / specification (optional)" value={spec} onChangeText={setSpec} placeholder="e.g. 200mm, bastard cut" />
        </Card>

        <Card title="Company" icon="pricetags-outline" subtitle="Pick one, or add a new company">
          <Chips options={['', ...(brands.data ?? []).map((b) => b.id), NEW]} value={brandId} onChange={setBrandId}
            format={(v) => (v === NEW ? '＋ New company' : v ? brands.data?.find((b) => b.id === v)?.name ?? '' : 'None')} />
          {brandId === NEW ? (
            <View style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-end' }}>
              <Field label="New company name" value={newBrand} onChangeText={setNewBrand} placeholder="e.g. JK Files" />
              <SmallButton title="Add company" kind="primary" icon="add" onPress={() => addBrand.mutate()} disabled={newBrand.trim().length < 2 || addBrand.isPending} />
            </View>
          ) : null}
        </Card>

        <Card title="Category" icon="folder-open-outline" subtitle="Optional — pick one, or add a new category">
          <Chips options={['', ...cats.map((c) => c.id), NEW]} value={catId} onChange={setCatId}
            format={(v) => (v === NEW ? '＋ New category' : v ? cats.find((c) => c.id === v)?.path ?? '' : 'None')} />
          {catId === NEW ? (
            <>
              <Field label="New category name" value={newCat} onChangeText={setNewCat} placeholder="e.g. Files & Rasps" />
              {cats.length ? (
                <>
                  <Label muted>Put it inside another category? (optional)</Label>
                  <Chips options={['', ...cats.map((c) => c.id)]} value={catParent} onChange={setCatParent}
                    format={(v) => (v ? cats.find((c) => c.id === v)?.path ?? '' : 'No — top level')} />
                </>
              ) : null}
              <SmallButton title="Add category" kind="primary" icon="add" onPress={() => addCat.mutate()} disabled={newCat.trim().length < 2 || addCat.isPending} />
            </>
          ) : null}
        </Card>

        <Card title="Tax & price" icon="calculator-outline">
          <Field label="HSN code" value={hsn} keyboardType="number-pad" maxLength={8} onChangeText={(v) => setHsn(v.replace(/\D/g, ''))}
            placeholder="4, 6 or 8 digits" error={hsn && !hsnOk ? 'HSN must be 4, 6 or 8 digits' : undefined} />
          <Label>GST % (0% = Non-GST)</Label>
          <Chips options={(slabs.data ?? []).map((s) => Number(s.rate))} value={gst} onChange={setGst} format={(r) => `${r}%`} />
          <Field label={forPurchase ? `Selling price per ${unit} excl. GST (what customers pay)` : `Price per ${unit} excl. GST`} value={price} keyboardType="decimal-pad" onChangeText={setPrice} placeholder="e.g. 145"
            error={!priceOk ? 'Enter a number' : undefined} />
          {incl != null ? <Label muted>= {formatINR(incl)} per {unit} incl. {gst}% GST</Label> : null}
        </Card>

        <Card title="Units & packing" icon="file-tray-stacked-outline">
          <Label>Counted in</Label>
          <Chips options={UNITS} value={unit} onChange={setUnit} />
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Field label={`Std packing (${unit} per pack)`} value={pkg} keyboardType="number-pad" onChangeText={setPkg} placeholder="e.g. 12"
              error={!whole(pkg) ? 'Whole number' : undefined} />
            <Field label={`MOQ (${unit} per carton)`} value={moq} keyboardType="number-pad" onChangeText={setMoq} placeholder="e.g. 144"
              error={!whole(moq) ? 'Whole number' : undefined} />
          </View>
          <Label muted>Std packing above 1 adds a PACK unit; MOQ adds a CTN unit, so the bill can be in {unit}, packs or cartons.</Label>
        </Card>

        {brandId === NEW || catId === NEW ? <Notice tone="warning">Tap “Add company” / “Add category” first, or choose an existing one.</Notice> : null}
        <Button title="Save item and add to bill" icon="checkmark" onPress={() => save.mutate()} busy={save.isPending} disabled={!valid} />
      </ScrollView>
    </Modal>
  );
}
