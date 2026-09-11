import { defineConfig } from 'vitest/config';

/**
 * The Site workspace has its own Vitest include pattern. This package must
 * keep an explicit local boundary so its security regression tests are not
 * silently excluded when invoked from the submodule directory.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
