import type { Uom } from '@wh/shared';

export interface ProductHit {
  id: string;
  sku_code: string;
  name: string;
  brand: string | null;
  category_path: string | null;
  specification: string | null;
  hsn_code: string | null;
  default_gst_rate: number;
  default_selling_price: number | null;
  mrp: number | null;
  qty_on_hand: number;
  image_path: string | null;      // product-images bucket (public)
  aliases: string[] | null;
  uoms: { code: string; factor: number; displayName: string }[];
}

export const toUoms = (p: ProductHit): Uom[] => p.uoms.map((u) => ({ code: u.code, factor: u.factor, displayName: u.displayName }));

export interface Party { id: string; name: string; gstin: string | null; state_code: string | null; phone: string | null }
export interface Me { id: string; login_id: string; full_name: string; role: string; warehouse_id: string | null; warehouse_code: string | null; warehouse_name: string | null; warehouse_state: string | null }
export interface Warehouse { id: string; code: string; name: string; state_code: string; address?: string | null; gstin?: string | null; is_active?: boolean }
