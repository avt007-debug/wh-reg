/** Error codes raised by the database (SQLSTATE) and returned by the API as `code`. */
export const ERROR_CODES = {
  WH001: { http: 409, key: 'INSUFFICIENT_STOCK', message: 'Not enough stock in this warehouse' },
  WH002: { http: 403, key: 'FORBIDDEN', message: 'You are not allowed to do this' },
  WH003: { http: 429, key: 'PIN_LOCKED', message: 'Too many wrong PIN attempts' },
  WH004: { http: 403, key: 'INVALID_PIN', message: 'Incorrect override PIN' },
  WH005: { http: 422, key: 'VALIDATION', message: 'Invalid data' },
} as const;

export type ApiErrorKey = (typeof ERROR_CODES)[keyof typeof ERROR_CODES]['key'] | 'UNAUTHENTICATED' | 'CONFLICT' | 'NOT_FOUND' | 'INTERNAL';

export interface ApiError {
  code: ApiErrorKey;
  message: string;
  details?: unknown;
}

/** Shape of 409 INSUFFICIENT_STOCK details — the app uses it to prompt for the Admin PIN. */
export interface StockShortfall {
  productId: string;
  productName: string;
  availableBase: number;
  requestedBase: number;
}
