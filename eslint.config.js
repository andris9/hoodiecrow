'use strict';

const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
    {
        // local agent worktrees and settings
        ignores: ['.claude/**']
    },
    js.configs.recommended,
    {
        files: ['**/*.js'],
        languageOptions: {
            ecmaVersion: 2023,
            sourceType: 'commonjs',
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
            eqeqeq: ['error', 'always', { null: 'ignore' }],
            strict: ['error', 'global']
        }
    }
];
