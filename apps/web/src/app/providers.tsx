'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';

import { ApiError } from '@/lib/api-client';

/**
 * Client-side providers.
 *
 * The QueryClient is created inside state rather than at module scope. At module scope it would
 * be shared across every request during server rendering, which leaks one user's cached data
 * into another user's response — a real cross-tenant bug, not a theoretical one.
 */
export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            gcTime: 5 * 60_000,
            refetchOnWindowFocus: false,
            retry: (failureCount, error) => {
              // Retrying a 401, 403, 404, or 422 cannot succeed and only delays the error the
              // user needs to see. Retry transient failures only.
              if (error instanceof ApiError) {
                if (error.status >= 400 && error.status < 500 && error.status !== 429) return false;
              }
              return failureCount < 2;
            },
          },
          mutations: {
            // Mutations are never retried automatically: without an idempotency key a retry can
            // duplicate a record. Callers that are safe to retry opt in explicitly.
            retry: false,
          },
        },
      }),
  );

  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
