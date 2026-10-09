import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const section=(from,to)=>html.slice(html.indexOf(from),html.indexOf(to,html.indexOf(from)));
const extractStats=runInNewContext(section('function extractStats(', '// ─────────────────')+'\nextractStats');
const buckets=runInNewContext(section('function buildKdRankBuckets(', '/* ── RR GAINS')+'\nbuildKdRankBuckets');

test('Performance Score reads the live v4 field without dividing by rounds or using combat score',()=>{
  const player={stats:{kills:14,deaths:17,score:3953},performance:{score:226.70416482816853}};
  assert.equal(extractStats(player,20).performanceScore,player.performance.score);
  assert.equal(extractStats(player,20).acs,3953/20);
  for(const score of [undefined,null,'250',NaN,Infinity]){
    assert.equal(extractStats({...player,performance:{score}},20).performanceScore,null);
  }
  assert.equal(extractStats({...player,performance:{score:0}},20).performanceScore,0);
  assert.equal(extractStats({stats:player.stats},20).performanceScore,null);
});

test('group averages include genuine zero scores and exclude unavailable or invalid data',()=>{
  const matches=[0,300,null,undefined,NaN,Infinity].map(performanceScore=>({
    myStats:{kills:1,deaths:1,performanceScore},won:true,
  }));
  const [row]=buckets(()=>({tier:12,label:'Gold 1'}),{matches});
  assert.equal(row.total,6);
  assert.equal(row.performanceCount,2);
  assert.equal(row.performanceSum/row.performanceCount,150);
  const [legacy]=buckets(()=>({tier:12}),{matches:matches.slice(2)});
  assert.equal(legacy.performanceCount,0);
});

test('overview averages reported match scores independently of round counts and clears stale data',()=>{
  const elements=new Map(['sg-performance','sg-performance-pill'].map(id=>[id,{}]));
  const context={document:{getElementById:id=>elements.get(id)},statsPanelMatches:[
    {myStats:{performanceScore:100,rounds_played:10}},
    {myStats:{performanceScore:300,rounds_played:30}},
    {myStats:{performanceScore:null,rounds_played:20}},
    {myStats:{performanceScore:0}},
  ]};
  const source=section('  // Performance Score is already', '  // Avg ADR');
  runInNewContext(source,context);
  assert.equal(elements.get('sg-performance').textContent,'133.3');
  assert.match(elements.get('sg-performance-pill').title,/3 of 4/);
  runInNewContext(source,{...context,statsPanelMatches:[{myStats:{acs:200}}]});
  assert.equal(elements.get('sg-performance').textContent,'—');
});

test('fresh scores enrich archive-first matches by PUUID without losing stats or duplicating matches',()=>{
  const context={allMatches:[],TARGET_SEASON:'act',processMatch:raw=>raw,
    tagActPlacements:rows=>rows,tagPostResetPlacements:rows=>rows,
    setSeasonMatchCount:()=>{},renderAll:()=>{},setStatus:()=>{}};
  const publish=runInNewContext(section('  const rawMatches=new Map()', '  const onRateLimit=')+'\npublishMatches',context);
  const archived={metadata:{match_id:'match'},players:[
    {puuid:'me',stats:{kills:20},performance:null},
    {puuid:'friend',performance:{score:0}},
  ]};
  publish([archived]);
  publish([{metadata:{match_id:'match'},players:[
    {puuid:'friend',performance:{score:300}},
    {puuid:'me',stats:{kills:99},performance:{score:250}},
  ]}]);
  assert.equal(context.allMatches.length,1);
  assert.equal(context.allMatches[0].players[0].performance.score,250);
  assert.equal(context.allMatches[0].players[0].stats.kills,20);
  assert.equal(context.allMatches[0].players[1].performance.score,0);
  publish([archived]);
  assert.equal(context.allMatches[0].players[0].performance.score,250);
});
