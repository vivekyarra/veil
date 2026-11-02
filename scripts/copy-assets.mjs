import {mkdirSync,copyFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
const root=resolve(import.meta.dirname,'..');
// OBS reads these pages from real files, so they ship next to the main bundle.
for(const asset of ['rehearsal/cover.html','overlay/overlay.html']){
  const target=resolve(root,'app/dist-electron',asset);
  mkdirSync(dirname(target),{recursive:true});
  copyFileSync(resolve(root,'app/electron',asset),target);
}
