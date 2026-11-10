/** "All · Chittoor · Vijayawada" switch, shared across the owner's screens. */
import { useOwnerWarehouse, useWarehouses } from '../lib/warehouse';
import { Chips } from './ui';

const ALL = '__all__';

export function WarehouseSwitch({ allowAll = true }: { allowAll?: boolean }) {
  const whs = useWarehouses();
  const { id, set } = useOwnerWarehouse();
  const list = whs.data ?? [];
  const options = [...(allowAll ? [ALL] : []), ...list.map((w) => w.id)];
  const value = id ?? (allowAll ? ALL : list[0]?.id ?? null);
  return (
    <Chips options={options} value={value}
      onChange={(v) => set(v === ALL ? null : v)}
      format={(v) => (v === ALL ? 'All warehouses' : list.find((w) => w.id === v)?.name ?? v)} />
  );
}

/** Name of the selected warehouse (or "All warehouses"). */
export function useSelectedWarehouseName() {
  const whs = useWarehouses();
  const { id } = useOwnerWarehouse();
  return id ? whs.data?.find((w) => w.id === id)?.name ?? '' : 'All warehouses';
}
