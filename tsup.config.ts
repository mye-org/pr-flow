import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    cli: 'src/cli/main.ts',
  },
  format: ['cjs'],
  outDir: 'dist',
  outExtension: () => ({ js: '.cjs' }),
  platform: 'node',
  target: 'node20',
  bundle: true,
  minify: false,
  sourcemap: false,
  clean: true,
  noExternal: [/.*/],
  banner: {
    js: '#!/usr/bin/env node',
  },
});
