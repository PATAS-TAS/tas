module.exports = {
    parser: '@typescript-eslint/parser',
    extends: [
      'eslint:recommended',
      'plugin:@typescript-eslint/recommended',
      'plugin:prettier/recommended'
    ],
    plugins: ['@typescript-eslint', 'prettier'],
    env: {
      node: true,
      es6: true,
    },
    rules: {
      'prettier/prettier': 'error'
    }
  };