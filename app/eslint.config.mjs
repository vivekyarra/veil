import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import hooks from 'eslint-plugin-react-hooks';
export default tseslint.config({ignores:['dist/**','dist-electron/**','coverage/**','release/**','node_modules/**']},js.configs.recommended,...tseslint.configs.recommended,{files:['**/*.{ts,tsx,cts}'],plugins:{'react-hooks':hooks},rules:{'@typescript-eslint/no-explicit-any':'error','@typescript-eslint/no-unused-vars':['error',{argsIgnorePattern:'^_',varsIgnorePattern:'^_'}],'react-hooks/rules-of-hooks':'error','react-hooks/exhaustive-deps':'warn'}},{files:['**/*.mjs'],languageOptions:{globals:{process:'readonly',Buffer:'readonly',setTimeout:'readonly',clearTimeout:'readonly',window:'readonly',document:'readonly'}}});
