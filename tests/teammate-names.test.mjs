import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const source=html.slice(html.indexOf('let teammateNameState='),html.indexOf('\nfunction buildTeammates('));
const id='11111111-1111-4111-8111-111111111111';
function setup(apiGet){
  const context={_analysisGen:1,_analysisController:new AbortController(),
    PUUID_RE:/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    API_BASE:'/api',PUUID:'me',apiGet,renders:0,buildTeammates:()=>{context.renders++;}};
  const api=runInNewContext(source+'\n({refreshTeammateNames,currentTeammateIdentity,lookupTeammateRows})',context);
  return {context,...api};
}

test('current duo Riot ID replaces an archived name, with one lookup per analysis',async()=>{
  let calls=0;
  const api=setup(async(url,opts)=>{
    calls++;assert.equal(url,`/api/account-by-puuid/${id}`);
    assert.equal(opts.quiet,true);assert.equal(opts.cache,'no-store');
    return {j:{data:{puuid:id,name:'atakurd',tag:'pkk'}}};
  });
  const old={puuid:id,name:'kurdistan peek',tag:'musun'};
  await api.refreshTeammateNames([{key:id},{key:id.toUpperCase()}]);
  assert.equal(api.currentTeammateIdentity(old).name,'atakurd');
  assert.equal(api.currentTeammateIdentity(old).tag,'pkk');
  await api.refreshTeammateNames([{key:id}]);
  assert.equal(calls,1);assert.equal(api.context.renders,1);
  api.context._analysisGen++;
  assert.equal(api.currentTeammateIdentity(old),old);
  await api.refreshTeammateNames([{key:id}]);
  assert.equal(calls,2);
});

test('failed or mismatched lookups keep archived names and do not loop',async()=>{
  for(const result of [()=>{throw new Error('offline');},()=>({j:{data:{puuid:'wrong',name:'Wrong',tag:'ID'}}})]){
    let calls=0;
    const api=setup(async()=>{calls++;return result();});
    const old={puuid:id,name:'Old',tag:'OLD'};
    await api.refreshTeammateNames([{key:id},{key:'missing-puuid'}]);
    await api.refreshTeammateNames([{key:id}]);
    assert.equal(api.currentTeammateIdentity(old),old);
    assert.equal(calls,1);assert.equal(api.context.renders,0);
  }
});

test('duo refresh reads the real apiGet response envelope',async()=>{
  const start=html.indexOf('async function apiGet(');
  const end=html.indexOf('// Back-compat alias',start);
  const apiGet=runInNewContext(html.slice(start,end)+'\napiGet',{
    fetchApiJson:async()=>({r:{status:200,ok:true},j:{status:200,data:{puuid:id,name:'atakurd',tag:'pkk'}}}),
  });
  const api=setup(apiGet);
  await api.refreshTeammateNames([{key:id}]);
  const identity=api.currentTeammateIdentity({puuid:id,name:'kurdistan peek',tag:'musun'});
  assert.equal(identity.name,'atakurd');
  assert.equal(identity.tag,'pkk');
  assert.equal(api.context.renders,1);
});

test('late name response from a previous search cannot update the current search',async()=>{
  let finish;
  const api=setup(()=>new Promise(resolve=>{finish=resolve;}));
  const pending=api.refreshTeammateNames([{key:id}]);
  api.context._analysisGen++;
  finish({j:{data:{puuid:id,name:'Late',tag:'OLD'}}});
  await pending;
  assert.equal(api.context.renders,0);
  const old={puuid:id,name:'Archived',tag:'ID'};
  assert.equal(api.currentTeammateIdentity(old),old);
});

test('lookup collects duos across all loaded matches independently of UI filters',()=>{
  const api=setup(()=>{throw new Error('collecting IDs must not fetch');});
  const me={puuid:'me',team_id:'Blue',party_id:'party'};
  const friend={puuid:id,team_id:'Blue',party_id:'party'};
  const matches=[{myPartyId:'party',players:[me,friend,
    {puuid:'opponent',team_id:'Red',party_id:'party'},
    {puuid:'stranger',team_id:'Blue',party_id:'other'}]},
    {myPartyId:'party',players:[me,friend]}];
  const rows=api.lookupTeammateRows(matches);
  assert.equal(rows.length,1);assert.equal(rows[0].key,id);
});

test('duo rendering and filter rebuilds cannot initiate name refreshes',()=>{
  const build=html.slice(html.indexOf('function buildTeammates('),html.indexOf('\nfunction renderEncounters('));
  assert.doesNotMatch(build,/refreshTeammateNames|apiGet|fetch\(/);
});
