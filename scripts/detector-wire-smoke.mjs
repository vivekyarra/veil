import {spawn,execFileSync} from 'node:child_process';
import {writeFileSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import WebSocket from '../app/node_modules/ws/wrapper.mjs';
const root=resolve(import.meta.dirname,'..'),token='c'.repeat(64);
const frozen=process.argv.includes('--frozen');
const command=frozen?resolve(root,'detector/dist/veil-detector/veil-detector.exe'):resolve(root,'detector/.venv/Scripts/python.exe');
const child=spawn(command,frozen?[]:['-m','veil_detector.server'],{cwd:resolve(root,'detector'),windowsHide:true,env:{...process.env,VEIL_LOCAL_TOKEN:token,VEIL_PORT:'47325'},stdio:['ignore','ignore','pipe']});
let errors='';child.stderr.on('data',b=>{errors+=b.toString();});
let socket;
try {
  const headers={Authorization:'Bearer '+token};
  for(let i=0;i<160;i++){try{const h=await fetch('http://127.0.0.1:47325/v1/health',{headers});if(h.ok)break;}catch{}await new Promise(r=>setTimeout(r,250));}
  socket=new WebSocket('ws://127.0.0.1:47325/v1/events',{headers});
  const opened=await new Promise(r=>{socket.once('open',()=>r(true));socket.once('error',()=>r(false));setTimeout(()=>r(false),5000);});
  writeFileSync(resolve(root,'runtime/wire-smoke.json'),JSON.stringify({opened}));
  if(!opened)throw new Error('Event WebSocket did not open');
  const response=await fetch('http://127.0.0.1:47325/v1/frames',{method:'POST',headers:{...headers,'X-Veil-Frame':JSON.stringify({frame_id:1,timestamp_ns:0})},body:readFileSync(resolve(root,'app/tests/fixtures/synthetic-mail.png'))});
  if(!response.ok)throw new Error('Frame request failed');
  const result=await response.json();
  if(!result.detections.some(d=>d.kind==='email'))throw new Error('Bundled OCR did not detect the synthetic email');
  writeFileSync(resolve(root,frozen?'docs/frozen-detector-smoke.json':'runtime/wire-smoke.json'),JSON.stringify({frozen,opened,frame_status:response.status,detected_kinds:result.detections.map(d=>d.kind),metadata_only:!JSON.stringify(result).includes('@example'),processed_ms:result.processed_ms},null,2));
}finally{socket?.close();writeFileSync(resolve(root,'runtime/wire-smoke-stderr.log'),errors);if(child.pid)try{execFileSync('taskkill',['/pid',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});}catch{child.kill();}}
