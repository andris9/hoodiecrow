import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
    {
        ignores: ['dist/**', 'node_modules/**', '.claude/**']
    },
    js.configs.recommended,
    {
        files: ['**/*.js', '**/*.cjs', '**/*.ts'],
        languageOptions: {
            ecmaVersion: 2023,
            sourceType: 'module',
            globals: {
                ...globals.node
            }
        },
        rules: {
            'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
            'no-prototype-builtins': 'off',
            'no-var': 'error',
            'prefer-const': 'error',
            'prefer-arrow-callback': 'error',
            'one-var': ['error', 'never'],
            eqeqeq: ['error', 'always', { null: 'ignore' }]
        }
    },
    {
        files: ['**/*.cjs'],
        languageOptions: {
            sourceType: 'commonjs'
        },
        rules: {
            strict: ['error', 'global']
        }
    },
    {
        files: ['**/*.ts'],
        extends: [tseslint.configs.recommended],
        rules: {
            // handled by the TypeScript compiler
            'no-undef': 'off',
            'no-unused-vars': 'off',
            '@typescript-eslint/no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
            '@typescript-eslint/no-explicit-any': 'off'
        }
    },
    prettier
);
