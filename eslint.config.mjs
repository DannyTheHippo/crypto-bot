// @ts-check
import boundaries from 'eslint-plugin-boundaries';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'coverage/**',
      '.pnpm-store/**',
      '.pnpm-cache/**',
      'node_modules/**',
      'docs/**',
      'drizzle/**',
      'drizzle.config.ts',
      // Operator CLI scripts, run directly via `node` — not part of any tsconfig project (see
      // tsconfig.eslint.json's include list), so typed linting has no project context for them.
      'scripts/**',
      // Same class: the backtest data-fetch CLI is a bare .mjs run via `node`, outside tsconfig.
      'test/backtest/fetch-data.mjs',
      // Same class: the Fear&Greed-index fetch CLI for the non-price sweep, bare .mjs via `node`.
      'test/backtest/fetch-fng.mjs',
      // Same class: the standalone multi-strategy research sweep — bare .mjs run via `node`
      // (self-contained, no src/ imports), outside any tsconfig project.
      'test/backtest/multi-strategy/**',
      // Same class: the TP/SL/maxHold calibration study — bare .mjs run via `node`
      // (self-contained, no src/ imports), outside any tsconfig project.
      'test/backtest/bounds-calibration/**',
      // Same class: the entry fill-quality study — bare .mjs run via `node` (DB reads via `pg`
      // directly, no src/ imports), outside any tsconfig project.
      'test/backtest/entry-fill-quality/**',
      // Same class: the stop-slippage exit-leak study — bare .mjs run via `node` (DB reads via
      // `pg` directly, no src/ imports), outside any tsconfig project.
      'test/backtest/stop-slippage/**',
      // Same class: the info-context×thinking A/B cell-table script — bare .mjs run via `node`
      // (DB reads via `pg` directly, no src/ imports), outside any tsconfig project.
      'test/backtest/ab-cells/**',
      // Same class: these specs import scripts/*.mjs (themselves outside tsconfig, see
      // scripts/** above) and are plain .mjs for the same reason — no tsconfig project.
      'test/unit/scripts/arm-ceremony.spec.mjs',
      'test/unit/scripts/resolve-stale-orders.spec.mjs',
      // Harness agent worktrees — full repo copies whose files have no tsconfig project context.
      '.claude/**',
    ],
  },
  ...tseslint.configs.recommendedTypeChecked,
  // Boundaries wall — scoped to src/** so root config files don't trigger no-unknown-files
  {
    files: ['src/**/*'],
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ['vitest.config.ts', 'eslint.config.mjs'],
          defaultProject: './tsconfig.eslint.json',
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      boundaries,
    },
    settings: {
      'import/resolver': { node: { extensions: ['.ts', '.js'] } },
      'boundaries/elements': [
        {
          type: 'app',
          pattern: ['src/app.module.ts', 'src/main.ts'],
          mode: 'full',
        },
        {
          type: 'domain',
          pattern: 'src/domain',
          mode: 'folder',
        },
        {
          type: 'ports',
          pattern: 'src/ports',
          mode: 'folder',
        },
        {
          type: 'config',
          pattern: 'src/config',
          mode: 'folder',
        },
        {
          type: 'shared',
          pattern: 'src/shared',
          mode: 'folder',
        },
        {
          type: 'database',
          pattern: 'src/database',
          mode: 'folder',
        },
        {
          type: 'features',
          pattern: 'src/features/*/*',
          mode: 'folder',
          capture: ['groupName', 'featureName'],
        },
      ],
      'boundaries/ignore': ['**/*.spec.ts', '**/*.test.ts'],
    },
    rules: {
      'boundaries/dependencies': [
        'error',
        {
          default: 'disallow',
          rules: [
            {
              from: ['domain'],
              allow: ['domain'],
            },
            {
              from: ['ports'],
              allow: ['domain', 'ports'],
            },
            {
              // Cross-cutting zone (template mirror): base exception, global filter. Pure of
              // feature knowledge — reaches only downward.
              from: ['shared'],
              allow: ['shared', 'domain', 'ports'],
            },
            {
              // Bootstrap/config zone (template mirror): env schema + typed facade. May not reach
              // into modules — it is upstream of every feature.
              from: ['config'],
              allow: ['domain', 'ports', 'config', 'shared'],
            },
            {
              // Composition-root-only zone: repositories/schema behind the DI tokens in ports/.
              // Modules never import it directly (they never had cross-module persistence imports).
              from: ['database'],
              allow: ['database', 'domain', 'ports', 'config', 'shared'],
            },
            {
              // Features (template mirror): may inject the TypedConfigService facade (the
              // sanctioned config read path) and their OWN feature only — never each other, never
              // database (the composition-root bridge pattern carries tokens across).
              from: [['features', { featureName: '*' }]],
              allow: [
                'domain',
                'ports',
                'config',
                'shared',
                ['features', { featureName: '${from.featureName}' }],
              ],
            },
            {
              from: ['app'],
              allow: ['domain', 'ports', 'config', 'shared', 'database', 'features', 'app'],
            },
          ],
        },
      ],
      'boundaries/no-unknown': ['error'],
      'boundaries/no-unknown-files': ['error'],
    },
  },
  // Test files: classic project mode — no allowDefaultProject file cap (>8 breaks it)
  {
    files: ['test/**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: false,
        project: './tsconfig.eslint.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  // Root config files: small fixed set, allowDefaultProject is fine here
  {
    files: ['vitest.config.ts', 'eslint.config.mjs'],
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ['vitest.config.ts', 'eslint.config.mjs'],
          defaultProject: './tsconfig.eslint.json',
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  // Domain purity: all purity selectors + money selectors apply to all domain files
  {
    files: ['src/domain/**/*'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: ['@nestjs/*', 'ccxt', 'pg', 'drizzle-orm'],
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'process', message: 'Domain must not access process' },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: 'CallExpression[callee.object.name="Date"][callee.property.name="now"]',
          message: 'Domain must not use Date.now()',
        },
        {
          selector: 'NewExpression[callee.name="Date"][arguments.length=0]',
          message: 'Domain must not use new Date() without arguments',
        },
        {
          selector: 'MemberExpression[object.name="Math"][property.name="random"]',
          message: 'Domain must not use Math.random()',
        },
        {
          selector: 'CallExpression[callee.name="parseFloat"]',
          message: 'Use decimal.js for money values, not parseFloat()',
        },
        {
          selector:
            'CallExpression[callee.object.name="Number"][callee.property.name="parseFloat"]',
          message: 'Use decimal.js for money values, not Number.parseFloat()',
        },
        {
          selector: 'CallExpression[callee.object.name="Number"][callee.property.name="parseInt"]',
          message: 'Use decimal.js for money values, not Number.parseInt()',
        },
        {
          selector: 'CallExpression[callee.name="Number"]',
          message: 'Use decimal.js for money values, not Number()',
        },
      ],
    },
  },
  // domain/types/money.ts: purity selectors only; money selectors are exempt here (Phase 1)
  {
    files: ['src/domain/types/money.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'CallExpression[callee.object.name="Date"][callee.property.name="now"]',
          message: 'Domain must not use Date.now()',
        },
        {
          selector: 'NewExpression[callee.name="Date"][arguments.length=0]',
          message: 'Domain must not use new Date() without arguments',
        },
        {
          selector: 'MemberExpression[object.name="Math"][property.name="random"]',
          message: 'Domain must not use Math.random()',
        },
      ],
    },
  },
  // All src outside domain: money selectors only (no purity selectors)
  {
    files: ['src/**/*'],
    ignores: ['src/domain/**/*'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'CallExpression[callee.name="parseFloat"]',
          message: 'Use decimal.js for money values, not parseFloat()',
        },
        {
          selector: 'CallExpression[callee.name="Number"]',
          message: 'Use decimal.js for money values, not Number()',
        },
        {
          selector:
            'CallExpression[callee.object.name="Number"][callee.property.name="parseFloat"]',
          message: 'Use decimal.js for money values, not Number.parseFloat()',
        },
        {
          selector: 'CallExpression[callee.object.name="Number"][callee.property.name="parseInt"]',
          message: 'Use decimal.js for money values, not Number.parseInt()',
        },
      ],
    },
  },
  {
    files: ['test/**/*.ts', '**/*.spec.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'MemberExpression[property.name="toBeCloseTo"]',
          message: 'Use exact string equality for money assertions, not toBeCloseTo',
        },
      ],
    },
  },
  // Minting boundary: only src/domain/risk/ and src/features/trading/risk/ may import from
  // domain/risk/minting. All other files must go through the public port.
  {
    files: ['src/**/*', 'test/**/*'],
    ignores: ['src/domain/risk/**', 'src/features/trading/risk/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/domain/risk/minting', '**/domain/risk/minting/**'],
              message:
                'Import domain/risk/minting only from src/domain/risk/ or src/features/trading/risk/.',
            },
          ],
        },
      ],
    },
  },
  // Template DTO naming (mirrors template-mern): the file suffix and the exported class suffix
  // agree, and the nest-cli swagger plugin keys off the same dtoFileNameSuffix list.
  {
    files: ['src/**/*.request.dto.ts'],
    rules: {
      '@typescript-eslint/naming-convention': [
        'error',
        { selector: 'class', format: ['PascalCase'], suffix: ['RequestDto'] },
      ],
    },
  },
  {
    files: ['src/**/*.response.dto.ts'],
    rules: {
      '@typescript-eslint/naming-convention': [
        'error',
        { selector: 'class', format: ['PascalCase'], suffix: ['ResponseDto'] },
      ],
    },
  },
  // Template mirror: api-examples exports are Record<string, ApiResponseOptions> literals keyed by
  // outcome name (success/refused/...) — warn (not error) since these are docs fixtures, not
  // wire-contract code.
  {
    files: ['src/**/*.api-examples.ts'],
    rules: {
      '@typescript-eslint/naming-convention': [
        'warn',
        {
          selector: 'variable',
          modifiers: ['exported'],
          format: ['camelCase'],
        },
      ],
    },
  },
);
