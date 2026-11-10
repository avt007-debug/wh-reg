/**
 * Enter EITHER the base price (excl. GST) OR the inclusive price; the other is
 * computed instantly with the same rounding the database enforces, so staff
 * never do GST arithmetic by hand.
 */
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { formatINR, fromBase, fromInclusive, type UnitPrice } from '@wh/shared';
import { Chips, Field, Label } from './ui';

export function PriceGstField({ gstRate, slabs, onRateChange, value, onChange, unitLabel, baseLabel, inclLabel }: {
  gstRate: number;
  slabs: number[];
  onRateChange: (r: number) => void;
  value: UnitPrice | null;
  onChange: (p: UnitPrice | null) => void;
  unitLabel: string;
  /** override the field captions, e.g. "Price before GST" / "MRP (incl. GST)" */
  baseLabel?: string;
  inclLabel?: string;
}) {
  const [baseText, setBaseText] = useState(value ? String(value.base) : '');
  const [inclText, setInclText] = useState(value ? value.inclusive.toFixed(2) : '');
  const [lastEdited, setLastEdited] = useState<'base' | 'incl'>('base');

  // Changing the slab recomputes from whichever field the user typed last.
  useEffect(() => {
    if (lastEdited === 'base') onBase(baseText); else onIncl(inclText);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gstRate]);

  function onBase(txt: string) {
    setLastEdited('base'); setBaseText(txt);
    const n = Number(txt);
    if (!txt || !Number.isFinite(n)) { setInclText(''); onChange(null); return; }
    const p = fromBase(n, gstRate);
    setInclText(p.inclusive.toFixed(2)); onChange(p);
  }
  function onIncl(txt: string) {
    setLastEdited('incl'); setInclText(txt);
    const n = Number(txt);
    if (!txt || !Number.isFinite(n)) { setBaseText(''); onChange(null); return; }
    const p = fromInclusive(n, gstRate);
    setBaseText(String(p.base)); onChange(p);
  }

  return (
    <View style={{ gap: 8 }}>
      <Label>GST slab</Label>
      <Chips options={slabs} value={gstRate} onChange={onRateChange} format={(r) => `${r}%`} />
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <Field label={baseLabel ?? `Base / ${unitLabel} (excl. GST)`} keyboardType="decimal-pad" value={baseText} onChangeText={onBase} placeholder="0.00" />
        <Field label={inclLabel ?? `Inclusive / ${unitLabel}`} keyboardType="decimal-pad" value={inclText} onChangeText={onIncl} placeholder="0.00" />
      </View>
      {value ? <Label muted>GST per {unitLabel}: {formatINR(value.tax)}</Label> : null}
    </View>
  );
}
