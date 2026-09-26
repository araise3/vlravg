import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const start=html.indexOf('const MAX_HISTORY_OFFSET=');
const end=html.indexOf("// Henrik's stored-matches endpoint",start);
assert.ok(start>0&&end>start);

function makeSeek(matches){
  const urls=[];
  const context={
    API_BASE:'/api',REGION:'eu',PLATFORM:'pc',PLAYER:'Transferred',TAG:'1234',
    _analysisGen:1,BATCH:10,setStatus(){},
    apiGet:async url=>{
      urls.push(url);
      const index=Number(new URL(url,'https://example.test').searchParams.get('start'));
      return{j:{data:matches[index]?[matches[index]]:[]}};
    },
  };
  const seek=runInNewContext(html.slice(start,end)+'\nfindHistoryStartForAct',context);
  return{seek,urls};
}

test('act lookup seeks by match dates, independent of regional MMR game totals',async()=>{
  const newer=Array.from({length:40},()=>({metadata:{started_at:'2020-03-01T00:00:00Z'}}));
  const target=Array.from({length:25},()=>({metadata:{started_at:'2020-01-15T00:00:00Z'}}));
  const older=Array.from({length:10},()=>({metadata:{started_at:'2019-12-01T00:00:00Z'}}));
  const {seek,urls}=makeSeek([...newer,...target,...older]);
  assert.equal(await seek(Date.parse('2020-02-01T00:00:00Z'),1),30);
  assert.ok(urls.every(url=>url.includes('size=1')));
});

test('act lookup scans from newest when match dates cannot be trusted',async()=>{
  const {seek}=makeSeek([{metadata:{started_at:'invalid'}}]);
  assert.equal(await seek(Date.parse('2020-02-01T00:00:00Z'),1),0);
});
