/**
 * Request contracts shared by mobile (form validation) and API (server validation).
 * IDs use z.guid() (any 8-4-4-4-12 hex) so seed/dev ids validate too.
 */
import { z } from 'zod';
import { isConsistent } from './gst.js';
import { isValidMobile, isValidVehicleNo, normalizeMobile, normalizeVehicleNo } from './india.js';

const id = z.guid();
const money = z.number().nonnegative().max(1e10);
const qty = z.number().positive().max(1e9);
const gstRate = z.number().min(0).max(100);
const isoDate = z.iso.date();

export const ROLES = ['OWNER', 'ADMIN', 'EMPLOYEE'] as const;
export type Role = (typeof ROLES)[number] | 'SYSTEM';
export const isOwnerRole = (r: Role) => r === 'OWNER' || r === 'ADMIN' || r === 'SYSTEM';

export const TRANSPORT_MODES = ['OWN_VEHICLE', 'TRANSPORTER', 'COURIER', 'CUSTOMER_PICKUP', 'RAIL', 'AIR'] as const;

// ---------------------------------------------------------------- auth
export const loginSchema = z.object({
  loginId: z.string().trim().min(3).max(32),
  password: z.string().min(8).max(128),
  deviceLabel: z.string().max(60).optional(),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const refreshSchema = z.object({ refreshToken: z.string().min(20) });

// ---------------------------------------------------------------- inward
export const purchaseLineSchema = z
  .object({
    productId: id,
    uomCode: z.string().regex(/^[A-Z]{2,6}$/),
    qty,
    gstRate,
    unitBasePrice: money,
    unitInclPrice: money,
    hsnCode: z.string().regex(/^[0-9]{4}([0-9]{2}){0,2}$/).optional(),
  })
  .refine((l) => isConsistent(l.unitBasePrice, l.unitInclPrice, l.gstRate), {
    message: 'Base and inclusive price do not match the GST slab',
    path: ['unitInclPrice'],
  });

export const createPurchaseSchema = z.object({
  clientTxnId: id,                                   // generated on device; safe retries
  warehouseId: id.optional(),                        // owners only; staff = their warehouse
  vendorId: id,
  vendorInvoiceNo: z.string().trim().min(1).max(40),
  vendorInvoiceDate: isoDate,
  lorryReceiptNo: z.string().trim().max(40).optional(),
  freightAmount: money.default(0),
  lines: z.array(purchaseLineSchema).min(1).max(200),
  attachmentKeys: z.array(z.object({
    kind: z.enum(['VENDOR_INVOICE', 'LORRY_RECEIPT', 'OTHER']),
    storageKey: z.string().min(5),
    mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']),
  })).max(10).default([]),
});
export type CreatePurchaseInput = z.infer<typeof createPurchaseSchema>;

// ---------------------------------------------------------------- outward
export const dispatchLineSchema = z.object({
  productId: id,
  uomCode: z.string().regex(/^[A-Z]{2,6}$/),
  qty,
  unitBasePrice: money,                              // Base Selling Price excl. GST, per uom
  discountPct: z.number().min(0).max(100).default(0),
  gstRate: gstRate.optional(),                       // defaults to product's slab
});

export const createDispatchSchema = z
  .object({
    clientTxnId: id,
    warehouseId: id.optional(),
    customerId: id,
    salesAgentId: id.optional(),
    invoiceDate: isoDate.optional(),                 // owners only; staff are forced to today
    transportMode: z.enum(TRANSPORT_MODES),
    transporterName: z.string().trim().max(80).optional(),
    vehicleRegNo: z.string().transform(normalizeVehicleNo).refine(isValidVehicleNo, 'Invalid vehicle number').optional(),
    driverPhone: z.string().transform(normalizeMobile).refine(isValidMobile, 'Invalid mobile number').optional(),
    lrNumber: z.string().trim().max(40).optional(),
    ewayBillNo: z.string().regex(/^[0-9]{12}$/).optional(),
    overrideId: id.optional(),                       // from POST /overrides after PIN
    lines: z.array(dispatchLineSchema).min(1).max(200),
  })
  .refine((d) => !['OWN_VEHICLE', 'TRANSPORTER'].includes(d.transportMode) || !!d.vehicleRegNo, {
    message: 'Vehicle number is required for road transport',
    path: ['vehicleRegNo'],
  });
export type CreateDispatchInput = z.infer<typeof createDispatchSchema>;

export const overrideRequestSchema = z.object({
  pin: z.string().regex(/^[0-9]{6,8}$/),
  reason: z.string().trim().min(3).max(200),
  warehouseId: id.optional(),
});

// ---------------------------------------------------------------- transfers
export const createTransferSchema = z.object({
  clientTxnId: id,
  fromWarehouseId: id.optional(),                    // owners only
  toWarehouseId: id,
  vehicleRegNo: z.string().transform(normalizeVehicleNo).optional(),
  driverPhone: z.string().transform(normalizeMobile).optional(),
  ewayBillNo: z.string().regex(/^[0-9]{12}$/).optional(),
  remarks: z.string().max(300).optional(),
  dispatchNow: z.boolean().default(true),
  overrideId: id.optional(),
  lines: z.array(z.object({ productId: id, uomCode: z.string(), qty })).min(1).max(200),
});

export const receiveTransferSchema = z.object({
  lines: z.array(z.object({ lineNo: z.number().int().positive(), qtyReceivedBase: z.number().nonnegative() })).optional(),
});

// ---------------------------------------------------------------- owner
export const purchaseDiscountSchema = z
  .object({
    discountType: z.enum(['PERCENT', 'AMOUNT']),
    discountValue: z.number().nonnegative(),
    reason: z.string().max(200).optional(),
  })
  .refine((d) => d.discountType !== 'PERCENT' || d.discountValue <= 100, { message: 'Percent must be ≤ 100' });

export const stockAdjustmentSchema = z.object({
  warehouseId: id,
  productId: id,
  movement: z.enum(['ADJUST_DAMAGE', 'ADJUST_LOSS', 'ADJUST_FOUND', 'ADJUST_AUDIT', 'OPENING']),
  qtyDeltaBase: z.number().refine((n) => n !== 0, 'Quantity cannot be zero'),
  notes: z.string().max(300).optional(),
});

export const createUserSchema = z
  .object({
    loginId: z.string().regex(/^[A-Za-z0-9._-]{3,32}$/),
    fullName: z.string().trim().min(2).max(80),
    phone: z.string().transform(normalizeMobile).optional(),
    role: z.enum(ROLES),
    primaryWarehouseId: id.optional(),
    password: z.string().min(10).max(128),
  })
  .refine((u) => u.role !== 'EMPLOYEE' || !!u.primaryWarehouseId, {
    message: 'Employees must be assigned a warehouse',
    path: ['primaryWarehouseId'],
  });

export const dateRangeSchema = z.object({
  from: isoDate,
  to: isoDate,
  warehouseId: id.optional(),
  granularity: z.enum(['day', 'month']).default('day'),
});

export const reorderPoSchema = z.object({ warehouseId: id, productIds: z.array(id).min(1).max(200) });
