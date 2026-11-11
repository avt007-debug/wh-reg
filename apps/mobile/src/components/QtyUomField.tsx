import { View } from 'react-native';
import { toBaseQty, type Uom } from '@wh/shared';
import { Chips, Field, Label } from './ui';

/** Quantity + packaging unit (CTN / BOX / PCS) with live base-unit equivalent. */
export function QtyUomField({ uoms, uomCode, onUomChange, qty, onQtyChange }: {
  uoms: Uom[]; uomCode: string; onUomChange: (c: string) => void; qty: string; onQtyChange: (q: string) => void;
}) {
  const u = uoms.find((x) => x.code === uomCode);
  const base = uoms.find((x) => x.factor === 1)?.code ?? 'PCS';
  const n = Number(qty);
  return (
    <View style={{ gap: 8 }}>
      <Label>Units</Label>
      <Chips options={uoms.map((x) => x.code)} value={uomCode} onChange={onUomChange}
        format={(c) => { const f = Number(uoms.find((x) => x.code === c)?.factor ?? 1); return f === 1 ? c : `${c} (${f} ${base})`; }} />
      <Field label={`Quantity (${uomCode})`} keyboardType="decimal-pad" value={qty} onChangeText={onQtyChange} placeholder="0" />
      {u && u.factor !== 1 && n > 0 ? <Label muted>= {toBaseQty(n, u.factor)} {base}</Label> : null}
    </View>
  );
}
