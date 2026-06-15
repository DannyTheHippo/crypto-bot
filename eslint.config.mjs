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
      // Research/analysis tooling (EMA-cross backtest); validated by its own sanity test +
      // adversarial review, intentionally outside the production typecheck/lint gate.
      'test/backtest/**',
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
          type: 'modules',
          pattern: 'src/modules/*',
          mode: 'folder',
          capture: ['moduleName'],
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
              from: [['modules', { moduleName: '*' }]],
              allow: ['domain', 'ports', ['modules', { moduleName: '${from.moduleName}' }]],
            },
            {
              from: ['app'],
              allow: ['domain', 'ports', 'modules', 'app'],
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
  // Minting boundary: only src/domain/risk/ and src/modules/risk/ may import from
  // domain/risk/minting. All other files must go through the public port.
  {
    files: ['src/**/*', 'test/**/*'],
    ignores: ['src/domain/risk/**', 'src/modules/risk/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/domain/risk/minting', '**/domain/risk/minting/**'],
              message:
                'Import domain/risk/minting only from src/domain/risk/ or src/modules/risk/.',
            },
          ],
        },
      ],
    },
  },
);
