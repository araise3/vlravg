import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
function extract(name){
  const start=html.indexOf(`function ${name}(`);
  const end=html.indexOf('\n}',start)+2;
  assert.ok(start>0&&end>start,name);
  return html.slice(start,end);
}
const api=runInNewContext(['parseRRDetails','reportedRRStart','isRREligible','rrReportedStats','buildRRDetailsHtml'].map(extract).join('\n')+
  '\n({parseRRDetails,reportedRRStart,isRREligible,rrReportedStats,buildRRDetailsHtml})',{
  matchHtml:v=>String(v).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;'),
  avgLabelShort:t=>'Tier '+t,rrSigned:(n,d)=>(n<0?'−':'+')+Math.abs(n).toFixed(d),
});
const match=d=>({myRR:20,myTierId:18,partySize:1,myRRDetails:api.parseRRDetails(d)});

test('unavailable fields stay null while reported zero and false are preserved',()=>{
  const d=api.parseRRDetails({rr_performance_bonus:0,is_placement_match:false,rr_penalty:.25});
  assert.equal(d.bonus,0);assert.equal(d.placement,false);assert.equal(d.penalty,.25);
  assert.equal(d.afkPenalty,null);assert.equal(d.beforeRR,null);
  assert.equal(api.parseRRDetails({rr_performance_bonus:'5'}).bonus,null);
});
test('exact starting values normalize promotions and cumulative Immortal RR',()=>{
  assert.equal(api.reportedRRStart(api.parseRRDetails({tier_before_update:{id:17},rr_before_update:95})),1495);
  assert.equal(api.reportedRRStart(api.parseRRDetails({tier_before_update:{id:26},rr_before_update:350})),2450);
  assert.equal(api.reportedRRStart(api.parseRRDetails({rr_before_update:95})),null);
});
test('reported placement overrides the older act-opening heuristic',()=>{
  assert.equal(api.isRREligible(match({is_placement_match:true})),false);
  assert.equal(api.isRREligible({...match({is_placement_match:false}),actPlacement:true}),true);
  assert.equal(api.isRREligible({...match({}),actPlacement:true}),false);
});
test('bonus totals use the eligible covered set, including real zeros',()=>{
  const s=api.rrReportedStats([match({rr_performance_bonus:5}),match({rr_performance_bonus:0}),match({}),match({rr_performance_bonus:9,is_placement_match:true})]);
  assert.deepEqual({...s},{total:3,covered:2,bonusMatches:1,bonusTotal:5});
});
test('details preserve fractional penalty, escape strings, and explain missing coverage',()=>{
  const output=api.buildRRDetailsHtml(match({rr_performance_bonus:5,rr_penalty:.25,queue_id:'<img src=x>',is_placement_match:false}));
  assert.match(output,/Performance bonus/);assert.match(output,/0.25/);
  assert.ok(!output.includes('<img'));assert.match(output,/Placement match/);
  assert.match(api.buildRRDetailsHtml(match({})),/unavailable/);
  assert.equal(api.buildRRDetailsHtml({}), '');
});

test('stable API unknown movement sentinel is not displayed as a rank event',()=>{
  const m=match({competitive_movement:'MOVEMENT_UNKNOWN'});
  assert.equal(m.myRRDetails.movement,null);
  assert.ok(!api.buildRRDetailsHtml(m).includes('Competitive movement'));
});

test('history ingestion prefers exact starts across gaps, promotions and act transitions',()=>{
  const history=[
    {match_id:'first',date:'2026-10-01',season:{short:'old'},tier:{id:17},rr:95,elo:1495,last_change:20},
    {match_id:'promotion',date:'2026-10-03',season:{short:'new'},tier:{id:18},rr:10,elo:1510,last_change:17,
      tier_before_update:{id:17},rr_before_update:88,rr_performance_bonus:0,is_placement_match:false},
    {match_id:'immortal',date:'2026-10-04',season:{short:'new'},tier:{id:26},rr:350,last_change:20,
      tier_before_update:{id:24},rr_before_update:330},
    {match_id:'zero',date:'2026-10-05',season:{short:'new'},tier:{id:18},rr:20,last_change:20,
      tier_before_update:{id:18},rr_before_update:0},
    {match_id:'shield',date:'2026-10-06',season:{short:'new'},tier:{id:18},rr:0,last_change:-20,
      tier_before_update:{id:18},rr_before_update:0,was_derank_protected:true},
  ];
  const start=html.indexOf('        const history=(rrJ.data||rrJ).history||[];');
  const end=html.indexOf('\n        });',start)+'\n        });'.length;
  assert.ok(start>0&&end>start);
  const names=['_rrChangeByMatchId','_rrDetailsByMatchId','_preRRByMatchId','_preTierByMatchId',
    '_postRRByMatchId','_postTierByMatchId','_refundedRRByMatchId','_derankProtectedByMatchId'];
  const context=Object.fromEntries(names.map(name=>[name,{}]));
  Object.assign(context,{rrJ:{data:{history:history.reverse()}},parseRRDetails:api.parseRRDetails,reportedRRStart:api.reportedRRStart});
  runInNewContext(html.slice(start,end),context);
  assert.equal(context._preRRByMatchId.promotion,1488);
  assert.equal(context._preTierByMatchId.promotion,17);
  assert.equal(context._preRRByMatchId.immortal,2430);
  assert.equal(context._preTierByMatchId.immortal,24);
  assert.equal(context._preRRByMatchId.zero,1500);
  assert.equal(context._rrDetailsByMatchId.promotion.bonus,0);
  assert.equal(context._rrDetailsByMatchId.promotion.placement,false);
  assert.equal(context._preRRByMatchId.shield,1500);
  assert.equal(context._postRRByMatchId.shield,1500);
  assert.equal(context._rrChangeByMatchId.shield,-20);
  assert.equal(context._derankProtectedByMatchId.shield,true);
});
