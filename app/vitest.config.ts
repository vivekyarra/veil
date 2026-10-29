import {defineConfig} from 'vitest/config';
export default defineConfig({test:{testTimeout:20000,coverage:{provider:'v8',include:['electron/**/*.ts'],exclude:['electron/main.ts','electron/preload.cts'],reporter:['text','json-summary']}}});
