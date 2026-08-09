import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/**
 * Component tests for the web app.
 *
 * This existed nowhere until two attachment bugs shipped that only a rendered component could have
 * caught: an upload whose write was silently discarded because it never entered edit mode, and a
 * value shape the server rejected. Neither is visible to a typechecker or to an API smoke test —
 * both paths were individually fine and wrong together.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['test/**/*.test.tsx', 'test/**/*.test.ts'],
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
});
