import { QueryClient } from '@tanstack/react-query';

/** One shared cache. Cleared on log-out so the next person on the same phone never sees the previous person's data. */
export const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 30_000 } },
});
