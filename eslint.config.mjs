import { defineConfig } from 'eslint/config';
import obsidianmd from 'eslint-plugin-obsidianmd';

export default defineConfig([
  { ignores: ['node_modules/**', 'dist/**', 'main.js', '.test-vault/**', 'host-smoke-*/**', 'coverage/**'] },
  ...obsidianmd.configs.recommended,
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      'obsidianmd/ui/sentence-case': ['warn', { brands: ['Better MD Diff', 'Markdown', 'Git'], acronyms: ['HEAD', 'PATH', 'Tab'] }],
    },
  },
]);
