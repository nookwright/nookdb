import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Shared TypeScript rule set — used verbatim by both the nookdb and react blocks.
 * Centralised here to prevent silent divergence when rules are tuned later.
 */
const sharedTsRules = {
  ...tseslint.configs['recommended-type-checked'].rules,
  ...tseslint.configs['stylistic-type-checked'].rules,
  '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
  '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
  '@typescript-eslint/explicit-module-boundary-types': 'error',
  'no-console': ['warn', { allow: ['warn', 'error'] }],
  // The three rules below extend ESLint core rules via getESLintCoreRule(), an
  // internal API removed in ESLint v9. They crash at rule-load time with
  // @typescript-eslint v7. Disabling them works around the tool incompatibility;
  // the underlying code quality is enforced by the other enabled rules.
  'dot-notation': 'off',
  '@typescript-eslint/dot-notation': 'off',
  'no-empty-function': 'off',
  '@typescript-eslint/no-empty-function': 'off',
  'no-loss-of-precision': 'off',
  '@typescript-eslint/no-loss-of-precision': 'off',
};

export default [
  {
    ignores: ['dist/', 'node_modules/', 'target/', '**/*.cjs'],
  },
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        project: [resolve(__dirname, 'packages/nookdb/tsconfig.eslint.json')],
        tsconfigRootDir: __dirname,
      },
    },
    plugins: { '@typescript-eslint': tseslint },
    rules: { ...sharedTsRules },
  },
  {
    files: ['**/__tests__/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
    },
  },
  // --- @nookdb/react (typed lint for .ts + .tsx with JSX) ---
  {
    files: ['packages/react/src/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        project: [resolve(__dirname, 'packages/react/tsconfig.eslint.json')],
        tsconfigRootDir: __dirname,
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: { '@typescript-eslint': tseslint },
    rules: { ...sharedTsRules },
  },
  {
    files: ['packages/react/src/**/__tests__/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/unbound-method': 'off',
    },
  },
  // --- @nookdb/electron (typed lint for .ts) ---
  {
    files: ['packages/electron/src/**/*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        project: [resolve(__dirname, 'packages/electron/tsconfig.eslint.json')],
        tsconfigRootDir: __dirname,
      },
    },
    plugins: { '@typescript-eslint': tseslint },
    rules: { ...sharedTsRules },
  },
  {
    files: ['packages/electron/src/**/__tests__/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
    },
  },
];
