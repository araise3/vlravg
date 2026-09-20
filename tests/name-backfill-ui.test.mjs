import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const start=html.indexOf("let activePage='overview'");
const end=html.indexOf('// Name history has dates',start);
assert.ok(start>0&&end>start);
const source=html.slice(start,end)+'\n({loadOlderNames,getState:()=>({pages:nameBackfillPages,backfill:nameHistoryBackfill,rows:nameHistoryRows,busy:nameBackfillBusy,stopped:nameBackfillStopped})})';
const puuid='11111111-1111-4111-8111-111111111111';

function client(apiGet){
  const context={PUUID:puuid,_analysisGen:1,API_BASE:'/api',apiGet,sleep:async()=>{},renderNameHistory(){},
    document:{getElementById(){return{addEventListener(){}}}}};
  const ui=runInNewContext(source,context);
  runInNewContext('nameHistoryBackfill={available:true,complete:false,limited:false,next_start:0}',context);
  return ui;
}

test('the site button scans past the old 20-page cap and keeps each D1 result live',async()=>{
  let calls=0;
  const ui=client(async()=>{
    calls++;
    return{j:{data:{history:[{name:`Name ${calls}`}],backfill:{available:true,complete:calls===25,
      limited:false,next_start:calls*10,matchlist_complete:false,stored_page:1,stored_scanned:0}}}};
  });
  await ui.loadOlderNames();
  assert.equal(calls,25);
  assert.equal(ui.getState().pages,25);
  assert.equal(ui.getState().rows[0].name,'Name 25');
  assert.equal(ui.getState().backfill.complete,true);
  assert.equal(ui.getState().busy,false);
});

test('stop waits for the current page and resume continues from the saved cursor',async()=>{
  let finishFirst,calls=0;
  const ui=client(async()=>{
    calls++;
    if(calls===1)return new Promise(resolve=>{finishFirst=resolve;});
    return{j:{data:{history:[{name:'Older'}],backfill:{available:true,complete:true,
      limited:false,next_start:20,matchlist_complete:true,stored_page:2,stored_scanned:0}}}};
  });
  const running=ui.loadOlderNames();
  await ui.loadOlderNames();
  finishFirst({j:{data:{history:[{name:'First'}],backfill:{available:true,complete:false,
    limited:false,next_start:10,matchlist_complete:false,stored_page:1,stored_scanned:0}}}});
  await running;
  assert.equal(calls,1);
  assert.equal(ui.getState().backfill.next_start,10);
  assert.equal(ui.getState().stopped,true);
  await ui.loadOlderNames();
  assert.equal(calls,2);
  assert.equal(ui.getState().backfill.complete,true);
});
