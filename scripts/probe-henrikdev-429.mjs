// Trigger HenrikDev 429s on purpose and log what happens. Key from .dev.vars, never printed.
import {readFileSync,appendFileSync,writeFileSync} from 'node:fs';
const [,,varsFile,logFile]=process.argv;
const key=readFileSync(varsFile,'utf8').split(/\r?\n/).find(l=>l.startsWith('HENRIK_KEY='))?.slice(11).replace(/^"|"$/g,'').trim();
if(!key)throw new Error('no HENRIK_KEY');
const URL_='https://api.henrikdev.xyz/valorant/v1/by-puuid/stored-matches/ap/bcb31a19-9438-5997-942d-9d3e54fd0f08?size=1';
const MAX=400;let sent=0;const t0=Date.now();
writeFileSync(logFile,'');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function call(phase,note=''){
  if(++sent>MAX)throw new Error('request cap reached');
  const at=Date.now();
  const r=await fetch(URL_,{headers:{Authorization:key}});
  const h=n=>r.headers.get(n);
  let body='';try{body=(await r.text()).slice(0,200);}catch{}
  const row={phase,note,n:sent,t:+((at-t0)/1000).toFixed(2),ms:Date.now()-at,status:r.status,
    remaining:h('x-ratelimit-remaining'),reset:h('x-ratelimit-reset'),limit:h('x-ratelimit-limit'),
    retryAfter:h('retry-after'),ratelimit:h('ratelimit'),policy:h('ratelimit-policy'),cache:h('x-cache-status'),
    body:r.status===200?'':body};
  appendFileSync(logFile,JSON.stringify(row)+'\n');
  console.log(`${row.t.toFixed(1).padStart(6)}s ${phase.padEnd(9)} #${sent} ${r.status} rem=${row.remaining} reset=${row.reset} retry=${row.retryAfter} ${note}`);
  return row;
}
async function exhaust(phase){
  for(;;){const row=await call(phase);if(row.status===429)return row;}
}
// 1. Exhaust, then call exactly at the stated reset and just after it.
const first=await exhaust('exhaust1');
const resetS=Number(first.reset),retryS=Number(first.retryAfter);
console.log(`first 429: reset=${first.reset} retry-after=${first.retryAfter} body=${first.body}`);
const target=Date.now()+(Number.isFinite(resetS)?resetS:60)*1000;
await sleep(Math.max(0,target-Date.now()-500));
await call('recover','0.5 s before stated reset');
await sleep(Math.max(0,target-Date.now()));
let ok=null;
for(let i=0;i<20&&!ok;i++){const row=await call('recover',`${((Date.now()-target)/1000).toFixed(1)} s after stated reset`);if(row.status===200)ok=row;else await sleep(500);}
// 2. Counting: the first window after a 429 starts from how many?
console.log(`first success after the 429 window: remaining=${ok?.remaining}`);
// 3. Extension: exhaust again, then keep calling once a second while limited.
const second=await exhaust('exhaust2');
for(let i=0;i<120;i++){
  await sleep(1000);
  const row=await call('hammer');
  if(row.status===200){console.log(`reopened while hammering: remaining=${row.remaining}`);break;}
}
// 4. Repeat offence: same once more, comparing the policy and waits.
const third=await exhaust('exhaust3');
for(let i=0;i<120;i++){
  await sleep(1000);
  const row=await call('hammer2');
  if(row.status===200){console.log(`reopened (third window): remaining=${row.remaining} policy=${row.policy}`);break;}
}
console.log('requests sent',sent,'in',((Date.now()-t0)/1000).toFixed(0),'s');
