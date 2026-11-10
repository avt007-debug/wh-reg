/**
 * The owner's selected warehouse, shared by Dashboard / Reorder / Stock /
 * Purchases so switching once applies everywhere. null = all warehouses.
 */
import { useQuery } from '@tanstack/react-query';
import { create } from 'zustand';
import { q } from '../api/client';
import type { Warehouse } from '../api/types';
import { supabase } from './supabase';

export const useOwnerWarehouse = create<{ id: string | null; set: (id: string | null) => void }>((set) => ({
  id: null, set: (id) => set({ id }),
}));

export function useWarehouses(includeInactive = false) {
  return useQuery({
    queryKey: ['warehouses', includeInactive],
    queryFn: () => {
      let b = supabase.from('warehouses').select('id, code, name, state_code, address, gstin, is_active').order('name');
      if (!includeInactive) b = b.eq('is_active', true);
      return q<Warehouse[]>(b);
    },
    staleTime: 5 * 60_000,
  });
}

export const fileStamp = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 16).replace('T', '_').replace(':', '');
