import OBSWebSocket from '../app/node_modules/obs-websocket-js/dist/json.js';
import {writeFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
const root=resolve(import.meta.dirname,'..');
const obs=new OBSWebSocket();
const wait=ms=>new Promise(r=>setTimeout(r,ms));
try {
  await obs.connect('ws://127.0.0.1:4456','synthetic-local-only');
  const kinds=await obs.call('GetSourceFilterKindList');
  if(!kinds.sourceFilterKinds.includes('veil_guard'))throw new Error('Native filter did not load');
  const scenes=await obs.call('GetSceneList');
  if(!scenes.scenes.some(s=>s.sceneName==='VEIL Synthetic'))await obs.call('CreateScene',{sceneName:'VEIL Synthetic'});
  const inputs=await obs.call('GetInputList');
  if(!inputs.inputs.some(i=>i.inputName==='Synthetic fixture'))await obs.call('CreateInput',{sceneName:'VEIL Synthetic',inputName:'Synthetic fixture',inputKind:'image_source',inputSettings:{file:resolve(root,'bench/data/00000.jpg').replaceAll('\\','/')},sceneItemEnabled:true});
  await obs.call('SetCurrentProgramScene',{sceneName:'VEIL Synthetic'});
  const filters=await obs.call('GetSourceFilterList',{sourceName:'VEIL Synthetic'});
  if(!filters.filters.some(f=>f.filterName==='VEIL Guard'))await obs.call('CreateSourceFilter',{sourceName:'VEIL Synthetic',filterName:'VEIL Guard',filterKind:'veil_guard',filterSettings:{enabled:true,profile:1,delay_ms:750,sample_fps:4,test_pattern:true}});
  mkdirSync(resolve(root,'runtime/native-proof'),{recursive:true});
  const image=async name=>{const result=await obs.call('GetSourceScreenshot',{sourceName:'VEIL Synthetic',imageFormat:'png',imageWidth:640});writeFileSync(resolve(root,`runtime/native-proof/${name}.png`),Buffer.from(result.imageData.split(',')[1],'base64'));};
  await wait(2500);await image('balanced-test-pattern');
  await obs.call('SetSourceFilterSettings',{sourceName:'VEIL Synthetic',filterName:'VEIL Guard',filterSettings:{test_pattern:false,profile:2}});
  await wait(1500);await image('paranoid-unavailable');
  await obs.call('SetSourceFilterEnabled',{sourceName:'VEIL Synthetic',filterName:'VEIL Guard',filterEnabled:false});await image('unfiltered');
  const stats=await obs.call('GetStats');
  writeFileSync(resolve(root,'docs/native-obs-smoke.json'),JSON.stringify({obs:'31.1.1 portable Windows x64',plugin_loaded:true,source:'generated synthetic JPEG only',test_pattern_capture_executed:true,paranoid_detector_unavailable_capture_executed:true,frame_pixel_validation:'See native pixel validation output',renderTotalFrames:stats.renderTotalFrames,renderSkippedFrames:stats.renderSkippedFrames,scope:'Smoke only; no stream, no reference-GPU throughput or real OCR timing proof'},null,2));
  process.stdout.write('Native OBS source/filter captures completed\n');
}finally{await obs.disconnect();}
