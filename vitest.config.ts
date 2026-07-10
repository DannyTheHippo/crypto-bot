import swc from 'unplugin-swc';
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    // Harness agent worktrees live under .claude/worktrees/ and contain full repo copies —
    // without this exclude, positional filters like `vitest run test/unit` match their copies too.
    exclude: [...configDefaults.exclude, '**/.claude/**'],
    coverage: {
      provider: 'v8',
      thresholds: {
        lines: 90,
        branches: 85,
        functions: 90,
        statements: 90,
        // Money-critical decision logic: 100% branch (design §9). These globs fail the
        // build below threshold — Risk/OMS-reducer/ModeControl correctness is asserted,
        // not sampled. Per-glob thresholds apply to matched files; global covers the rest.
        'src/domain/risk/**/*.ts': { lines: 100, branches: 100, functions: 100, statements: 100 },
        'src/features/trading/risk/**/*.ts': {
          lines: 100,
          branches: 100,
          functions: 100,
          statements: 100,
        },
        'src/domain/oms/**/*.ts': { lines: 100, branches: 100, functions: 100, statements: 100 },
        'src/domain/mode/**/*.ts': { lines: 100, branches: 100, functions: 100, statements: 100 },
        // Execution is the order-authorization chokepoint (verify-reject matrix + write-ahead
        // ordering). The PaperExchangeAdapter (sim) stays at the global threshold — the
        // deterministic paper suite drives it hard.
        'src/features/trading/execution/**/*.ts': {
          lines: 100,
          branches: 100,
          functions: 100,
          statements: 100,
        },
        // ModeControl is the live-arming interlock. *.module.ts is excluded by the global
        // exclude pattern above, so only the service, controller, and hmac helper are gated.
        'src/features/trading/mode-control/**/*.ts': {
          lines: 100,
          branches: 100,
          functions: 100,
          statements: 100,
        },
      },
      exclude: [
        'src/main.ts',
        '**/*.module.ts',
        'test/**',
        '*.config.*',
        'dist/**',
        // DB-bound repository wrappers and schema definitions are thin SQL/DDL
        // with no branchable logic; they are covered by test:db (integration, unsandboxed).
        'src/database/schemas/**',
        'src/database/repositories/**',
      ],
    },
  },
  plugins: [
    swc.vite({
      module: { type: 'es6' },
    }),
  ],
});
