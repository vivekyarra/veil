import {mkdirSync,copyFileSync} from 'node:fs';
import {resolve} from 'node:path';
const root=resolve(import.meta.dirname,'..');
mkdirSync(resolve(root,'app/dist-electron/rehearsal'),{recursive:true});
copyFileSync(resolve(root,'app/electron/rehearsal/cover.html'),resolve(root,'app/dist-electron/rehearsal/cover.html'));
