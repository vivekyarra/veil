import OBSWebSocket from '../app/node_modules/obs-websocket-js/dist/json.js';
import {writeFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {inflateSync,deflateSync,crc32} from 'node:zlib';
const root=resolve(import.meta.dirname,'..');
const obs=new OBSWebSocket();
const wait=ms=>new Promise(r=>setTimeout(r,ms));
// Default mask and hold color. Masks are drawn after the 4:2:0 unpack, but the
// screenshot path may still convert color, so allow a few levels per channel.
const MASK=[0x7c,0x5c,0xff],TOLERANCE=6;
// Minimal decoder for the 8-bit, non-interlaced RGB/RGBA PNGs OBS returns.
const decodePng=buffer=>{
  let pos=8,width=0,height=0,channels=0;const idat=[];
  while(pos<buffer.length){
    const length=buffer.readUInt32BE(pos),type=buffer.toString('latin1',pos+4,pos+8),data=buffer.subarray(pos+8,pos+8+length);
    if(type==='IHDR'){width=data.readUInt32BE(0);height=data.readUInt32BE(4);if(data[8]!==8||data[12]!==0)throw new Error('Unsupported PNG');channels={2:3,6:4}[data[9]];if(!channels)throw new Error(`Unsupported PNG color type ${data[9]}`);}
    if(type==='IDAT')idat.push(data);
    if(type==='IEND')break;
    pos+=12+length;
  }
  const raw=inflateSync(Buffer.concat(idat)),stride=width*channels,pixels=Buffer.alloc(stride*height);
  for(let y=0;y<height;y++){
    const filter=raw[y*(stride+1)],line=raw.subarray(y*(stride+1)+1,(y+1)*(stride+1));
    for(let x=0;x<stride;x++){
      const a=x>=channels?pixels[y*stride+x-channels]:0,b=y?pixels[(y-1)*stride+x]:0,c=x>=channels&&y?pixels[(y-1)*stride+x-channels]:0;
      const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);
      const predictor=[0,a,b,(a+b)>>1,pa<=pb&&pa<=pc?a:pb<=pc?b:c][filter];
      if(predictor===undefined)throw new Error(`Unsupported PNG filter ${filter}`);
      pixels[y*stride+x]=(line[x]+predictor)&255;
    }
  }
  return {width,height,at4:(fx,fy)=>{const i=(Math.floor(fy*(height-1))*width+Math.floor(fx*(width-1)))*channels;return [pixels[i],pixels[i+1],pixels[i+2],channels===4?pixels[i+3]:255];},at:(fx,fy)=>{const i=(Math.floor(fy*(height-1))*width+Math.floor(fx*(width-1)))*channels;return [pixels[i],pixels[i+1],pixels[i+2]];}};
};
// Minimal RGBA PNG encoder for the transparent fixture.
const encodePng=(width,height,pixel)=>{
  const chunk=(type,data)=>{const head=Buffer.alloc(8);head.writeUInt32BE(data.length,0);head.write(type,4,'latin1');const crc=Buffer.alloc(4);crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4),data])),0);return Buffer.concat([head,data,crc]);};
  const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(width,0);ihdr.writeUInt32BE(height,4);ihdr[8]=8;ihdr[9]=6;
  const raw=Buffer.alloc((width*4+1)*height);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++)raw.set(pixel(x/width,y/height),y*(width*4+1)+1+x*4);
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);
};
const near=(rgb,want,tolerance)=>want.every((v,i)=>Math.abs(rgb[i]-v)<=tolerance);
const isMask=rgb=>rgb.every((v,i)=>Math.abs(v-MASK[i])<=TOLERANCE);
const hex=rgb=>'#'+rgb.map(v=>v.toString(16).padStart(2,'0')).join('');
// Inside the test-pattern rectangle (x 20-60 %, y 20-40 %) and outside it.
const INSIDE=[[.3,.25],[.4,.3],[.55,.35]],OUTSIDE=[[.05,.05],[.95,.05],[.05,.95],[.95,.95],[.5,.7]];
const checks=[];
const expect=(name,ok,detail)=>{checks.push({name,ok,detail});if(!ok)process.stderr.write(`FAIL ${name}: ${detail}\n`);};
try {
  await obs.connect(process.env.OBS_WEBSOCKET_URL??'ws://127.0.0.1:4456',process.env.OBS_WEBSOCKET_PASSWORD??'synthetic-local-only');
  // Render counters are cumulative since OBS launched; the delta isolates the
  // frames rendered while this smoke run drove the filter.
  const before=await obs.call('GetStats');
  const kinds=await obs.call('GetSourceFilterKindList');
  if(!kinds.sourceFilterKinds.includes('veil_guard'))throw new Error('Native filter did not load');
  const scenes=await obs.call('GetSceneList');
  if(!scenes.scenes.some(s=>s.sceneName==='VEIL Synthetic'))await obs.call('CreateScene',{sceneName:'VEIL Synthetic'});
  const inputs=await obs.call('GetInputList');
  if(!inputs.inputs.some(i=>i.inputName==='Synthetic fixture'))await obs.call('CreateInput',{sceneName:'VEIL Synthetic',inputName:'Synthetic fixture',inputKind:'image_source',inputSettings:{file:resolve(root,'bench/data/00000.jpg').replaceAll('\\','/')},sceneItemEnabled:true});
  await obs.call('SetCurrentProgramScene',{sceneName:'VEIL Synthetic'});
  const filters=await obs.call('GetSourceFilterList',{sourceName:'VEIL Synthetic'});
  const balanced={enabled:true,profile:1,delay_ms:750,sample_fps:4,test_pattern:true};
  if(!filters.filters.some(f=>f.filterName==='VEIL Guard'))await obs.call('CreateSourceFilter',{sourceName:'VEIL Synthetic',filterName:'VEIL Guard',filterKind:'veil_guard',filterSettings:balanced});
  // A rerun finds the filter as the last run left it: disabled and Paranoid.
  await obs.call('SetSourceFilterSettings',{sourceName:'VEIL Synthetic',filterName:'VEIL Guard',filterSettings:balanced});
  await obs.call('SetSourceFilterEnabled',{sourceName:'VEIL Synthetic',filterName:'VEIL Guard',filterEnabled:true});
  mkdirSync(resolve(root,'runtime/native-proof'),{recursive:true});
  const image=async name=>{const result=await obs.call('GetSourceScreenshot',{sourceName:'VEIL Synthetic',imageFormat:'png',imageWidth:640});const png=Buffer.from(result.imageData.split(',')[1],'base64');writeFileSync(resolve(root,`runtime/native-proof/${name}.png`),png);return decodePng(png);};
  await wait(2500);
  const pattern=await image('balanced-test-pattern');
  for(const [x,y] of INSIDE)expect(`test pattern is ${hex(MASK)} at ${x},${y}`,isMask(pattern.at(x,y)),hex(pattern.at(x,y)));
  expect('delayed frame is shown around the test pattern',OUTSIDE.some(([x,y])=>!isMask(pattern.at(x,y))),OUTSIDE.map(([x,y])=>hex(pattern.at(x,y))).join(' '));
  await obs.call('SetSourceFilterSettings',{sourceName:'VEIL Synthetic',filterName:'VEIL Guard',filterSettings:{test_pattern:false,profile:2}});
  await wait(1500);
  const held=await image('paranoid-unavailable');
  for(const [x,y] of [...INSIDE,...OUTSIDE,[0,0],[1,1]])expect(`Paranoid hold covers ${x},${y}`,isMask(held.at(x,y)),hex(held.at(x,y)));
  await obs.call('SetSourceFilterEnabled',{sourceName:'VEIL Synthetic',filterName:'VEIL Guard',filterEnabled:false});
  const plain=await image('unfiltered');
  expect('unfiltered capture is not the mask color',[...INSIDE,...OUTSIDE].some(([x,y])=>!isMask(plain.at(x,y))),'every probe matched the mask color');
  // Transparency: the filter sits on an image source whose left half is fully
  // transparent (white, alpha 0) and whose right half is opaque orange over
  // a 50 % red band, composited over a green scene background. Delayed
  // output must keep the alpha (green shows through, never a black box);
  // test-pattern masks and Paranoid holds must stay opaque over the
  // transparent half and cover exactly the source rectangle.
  const video=await obs.call('GetVideoSettings');
  const GREEN=[0,255,0],ORANGE=[0xe0,0x80,0x20],BLEND=[128,128,0];
  const fixture=resolve(root,'runtime/native-proof/alpha-fixture.png');
  writeFileSync(fixture,encodePng(480,270,(x,y)=>x<.5?[255,255,255,0]:y<.5?[...ORANGE,255]:[255,0,0,128]));
  if(!scenes.scenes.some(s=>s.sceneName==='VEIL Alpha'))await obs.call('CreateScene',{sceneName:'VEIL Alpha'});
  if(!inputs.inputs.some(i=>i.inputName==='Alpha background'))await obs.call('CreateInput',{sceneName:'VEIL Alpha',inputName:'Alpha background',inputKind:'color_source_v3',inputSettings:{color:0xff00ff00,width:video.baseWidth,height:video.baseHeight},sceneItemEnabled:true});
  if(!inputs.inputs.some(i=>i.inputName==='Alpha fixture'))await obs.call('CreateInput',{sceneName:'VEIL Alpha',inputName:'Alpha fixture',inputKind:'image_source',inputSettings:{file:fixture.replaceAll('\\','/')},sceneItemEnabled:true});
  // The fixture covers the top-left half of the canvas: x and y 0-50 %.
  const {sceneItemId}=await obs.call('GetSceneItemId',{sceneName:'VEIL Alpha',sourceName:'Alpha fixture'});
  await obs.call('SetSceneItemTransform',{sceneName:'VEIL Alpha',sceneItemId,sceneItemTransform:{positionX:0,positionY:0,scaleX:video.baseWidth/2/480,scaleY:video.baseHeight/2/270}});
  await obs.call('SetSceneItemIndex',{sceneName:'VEIL Alpha',sceneItemId,sceneItemIndex:1});
  await obs.call('SetCurrentProgramScene',{sceneName:'VEIL Alpha'});
  const alphaFilters=await obs.call('GetSourceFilterList',{sourceName:'Alpha fixture'});
  const alphaBalanced={enabled:true,profile:1,delay_ms:750,sample_fps:4,test_pattern:false,preserve_alpha:0};
  if(!alphaFilters.filters.some(f=>f.filterName==='VEIL Guard'))await obs.call('CreateSourceFilter',{sourceName:'Alpha fixture',filterName:'VEIL Guard',filterKind:'veil_guard',filterSettings:alphaBalanced});
  await obs.call('SetSourceFilterSettings',{sourceName:'Alpha fixture',filterName:'VEIL Guard',filterSettings:alphaBalanced});
  await obs.call('SetSourceFilterEnabled',{sourceName:'Alpha fixture',filterName:'VEIL Guard',filterEnabled:true});
  const scene=async name=>{const result=await obs.call('GetSourceScreenshot',{sourceName:'VEIL Alpha',imageFormat:'png',imageWidth:640});const png=Buffer.from(result.imageData.split(',')[1],'base64');writeFileSync(resolve(root,`runtime/native-proof/${name}.png`),png);return decodePng(png);};
  // Interior probes in canvas coordinates, away from chroma-subsampled edges.
  const CLEAR=[[.05,.05],[.1,.4],[.2,.25]],SOLID=[[.35,.1],[.45,.2]],HALF=[[.35,.4],[.45,.45]],BACKGROUND=[[.75,.25],[.25,.75],[.9,.9]];
  // A new image source decodes its file first; delayed output then appears
  // once the ring holds a frame older than the delay.
  let kept;
  for(const start=Date.now();Date.now()-start<10000;){await wait(500);kept=await scene('alpha-balanced');if(near(kept.at(...SOLID[0]),ORANGE,12))break;}
  for(const [x,y] of CLEAR)expect(`transparent area shows the scene at ${x},${y}`,near(kept.at(x,y),GREEN,12),hex(kept.at(x,y)));
  for(const [x,y] of SOLID)expect(`opaque area keeps its color at ${x},${y}`,near(kept.at(x,y),ORANGE,12),hex(kept.at(x,y)));
  for(const [x,y] of HALF)expect(`50 % alpha blends with the scene at ${x},${y}`,near(kept.at(x,y),BLEND,16),hex(kept.at(x,y)));
  await obs.call('SetSourceFilterSettings',{sourceName:'Alpha fixture',filterName:'VEIL Guard',filterSettings:{test_pattern:true}});
  await wait(1500);
  const masked=await scene('alpha-test-pattern');
  // Pattern: source x 20-60 %, y 20-40 %, i.e. canvas x 10-30 %, y 10-20 %.
  for(const [x,y] of [[.12,.12],[.2,.15],[.28,.18]])expect(`mask is opaque over transparency at ${x},${y}`,isMask(masked.at(x,y)),hex(masked.at(x,y)));
  expect('scene still shows around the mask',near(masked.at(.05,.05),GREEN,12),hex(masked.at(.05,.05)));
  await obs.call('SetSourceFilterSettings',{sourceName:'Alpha fixture',filterName:'VEIL Guard',filterSettings:{test_pattern:false,profile:2}});
  await wait(1500);
  const alphaHeld=await scene('alpha-paranoid-hold');
  for(const [x,y] of [...CLEAR,...SOLID,...HALF,[.01,.01],[.49,.49]])expect(`Paranoid hold is opaque at ${x},${y}`,isMask(alphaHeld.at(x,y)),hex(alphaHeld.at(x,y)));
  for(const [x,y] of BACKGROUND)expect(`hold stays inside the source rectangle at ${x},${y}`,near(alphaHeld.at(x,y),GREEN,12),hex(alphaHeld.at(x,y)));
  await obs.call('SetSourceFilterEnabled',{sourceName:'Alpha fixture',filterName:'VEIL Guard',filterEnabled:false});
  await obs.call('SetCurrentProgramScene',{sceneName:'VEIL Synthetic'});
  const stats=await obs.call('GetStats');
  const passed=checks.every(c=>c.ok);
  writeFileSync(resolve(root,'docs/evidence/native-obs-smoke.json'),JSON.stringify({obs:'31.1.1 portable Windows x64',plugin_loaded:true,source:'generated synthetic JPEG only',test_pattern_capture_executed:true,paranoid_detector_unavailable_capture_executed:true,transparent_source_capture_executed:true,frame_pixel_validation:{mask_color:hex(MASK),tolerance_levels:TOLERANCE,passed,checks:checks.length,failed:checks.filter(c=>!c.ok)},renderTotalFrames:stats.renderTotalFrames,renderSkippedFrames:stats.renderSkippedFrames,smokeRenderTotalFrames:stats.renderTotalFrames-before.renderTotalFrames,smokeRenderSkippedFrames:stats.renderSkippedFrames-before.renderSkippedFrames,averageFrameRenderTimeMs:stats.averageFrameRenderTime,scope:'Smoke only; no stream, no reference-GPU throughput or real OCR timing proof'},null,2));
  if(!passed)throw new Error(`${checks.filter(c=>!c.ok).length} of ${checks.length} pixel checks failed`);
  process.stdout.write(`Native OBS source/filter captures completed; ${checks.length} pixel checks passed (${hex(MASK)} +/-${TOLERANCE})\n`);
}finally{await obs.disconnect();}
