import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const start=html.indexOf('function computeEncounters(');
const end=html.indexOf('\nfunction buildTeammates(',start);
assert.ok(start>=0&&end>start);
const computeEncounters=runInNewContext(html.slice(start,end)+'\ncomputeEncounters');

const me={puuid:'me',name:'Me',tag:'TAG',team_id:'blue',party_id:'mine'};
const player=(puuid,name,team_id,party_id)=>({puuid,name,tag:'TAG',team_id,party_id});
const match=(others,startedAtMs,myPartyId='mine')=>({players:[me,...others],myPartyId,startedAtMs});

test('repeated opponents and non-party teammates count as encounters',()=>{
  const matches=[
    match([player('enemy','Enemy','red','other'),player('ally','Ally','blue','other')],100),
    match([player('enemy','Enemy','red','other'),player('ally','Ally','blue','other')],200),
    match([player('once','Once','red','other')],300),
  ];
  const rows=computeEncounters(matches,matches,'me','Me','TAG');
  assert.equal(rows.length,2);
  assert.equal(rows.find(row=>row.key==='id:enemy')?.opponents,2);
  assert.equal(rows.find(row=>row.key==='id:ally')?.sameTeam,2);
  assert.ok(!rows.some(row=>row.key==='id:once'));
});

test('a player who ever queued in your party is excluded from encounters',()=>{
  const shared=player('known','Known','blue','mine');
  const outside=player('known','Renamed','red','other');
  const matches=[match([shared],100),match([outside],200),match([outside],300)];
  assert.equal(computeEncounters(matches,matches,'me','Me','TAG').length,0);
});

test('same-team players need party data, while opponents can still count',()=>{
  const matches=[
    match([player('ally','Ally','blue',null),player('enemy','Enemy','red',null)],100,null),
    match([player('ally','Ally','blue',null),player('enemy','Enemy','red',null)],200,null),
  ];
  const rows=computeEncounters(matches,matches,'me','Me','TAG');
  assert.equal(rows.length,1);
  assert.equal(rows[0].key,'id:enemy');
  assert.equal(rows[0].games,2);
});
