/**
 * Configuration Vitest - FOREAS Driver Backend
 */

import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./src/tests/setup.ts'],
    include: ['src/**/*.{test,spec}.{js,ts}'],
    exclude: ['node_modules', 'dist', '.next'],
    testTimeout: 30000, // 30s timeout pour tests avec DB
    hookTimeout: 30000, // 30s pour setup/teardown
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        'dist/',
        'coverage/',
        'prisma/',
        '**/*.config.{ts,js}',
        '**/*.test.{ts,js}',
        '**/*.spec.{ts,js}',
      ],
    },
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
    },
  },
});