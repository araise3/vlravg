import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {closeRenderer,renderHtml} from './helpers/react-render.mjs';

after(closeRenderer);

const html=readFileSync(new URL('../src/engine/core.mjs',import.meta.url),'utf8');
function extract(name){
  const start=html.indexOf(`function ${name}(`);
  const end=html.indexOf('\n}',start)+2;
  assert.ok(start>0&&end>start,name);
  return html.slice(start,end);
}
const api=runInNewContext("const RR_RANGES=['all','50','30','20'];\n"+
  ['parseRRDetails','reportedRRStart','isRREligible','rrReportedStats','rrAdjustmentStats','rrDodgeEntry','rrDodgesInRange'].map(extract).join('\n')+
  '\n({parseRRDetails,reportedRRStart,isRREligible,rrReportedStats,rrAdjustmentStats,rrDodgeEntry,rrDodgesInRange})');
// The match card's "Your RR details" panel, rendered by React.
const details=m=>renderHtml('/src/app/pages/Matches.jsx','RRDetails',{m});
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
test('adjustments sum dodges, refunds and reported AFK penalties and count fractional party penalties without converting them',()=>{
  const dodges=[{change:-6},{change:-10}];
  const s=api.rrAdjustmentStats([match({afk_penalty:4}),match({afk_penalty:8,rr_penalty:.25}),match({afk_penalty:0}),
    match({rr_penalty:.25}),{...match({}),myPartyPenalty:.25,myRefundedRR:12},match({afk_penalty:-2,is_placement_match:true}),
    {...match({}),myRefundedRR:0}],dodges);
  // Every match in the range counts, placements included; a reported zero is coverage, null is not.
  assert.deepEqual({...s},{total:7,dodges:2,dodgeRR:-16,refunds:1,refundRR:12,afkCovered:4,afkMatches:3,afkRR:14,partyMatches:3,penaltyRR:-30});
  assert.deepEqual({...api.rrAdjustmentStats([match({}),{}])},
    {total:2,dodges:0,dodgeRR:0,refunds:0,refundRR:0,afkCovered:0,afkMatches:0,afkRR:0,partyMatches:0,penaltyRR:0});
});
test('dodges are MMR-history entries with a zero match length, scoped to the RR range by date',()=>{
  const entry=api.rrDodgeEntry({match_id:'d',match_length:0,last_change:-6,date:'2026-11-15T20:00:00Z',season:{id:'ACT'}});
  assert.deepEqual({...entry},{matchId:'d',atMs:Date.parse('2026-11-15T20:00:00Z'),change:-6,seasonId:'ACT'});
  // A played match, an older record without match_length and a missing change are not dodges.
  assert.equal(api.rrDodgeEntry({match_id:'m',match_length:1922269,last_change:16}),null);
  assert.equal(api.rrDodgeEntry({match_id:'old',last_change:-6}),null);
  assert.equal(api.rrDodgeEntry({match_id:'x',match_length:0}),null);
  const at=h=>Date.parse(`2026-11-15T${h}:00:00Z`);
  const dodges=[{atMs:at(10)},{atMs:at(14)},{atMs:null}];
  const scoped=[{startedAtMs:at(12)},{startedAtMs:at(16)}];
  assert.equal(api.rrDodgesInRange(dodges,scoped,'all').length,3);
  assert.deepEqual(api.rrDodgesInRange(dodges,scoped,'20').map(d=>d.atMs),[at(14)]);
  assert.equal(api.rrDodgesInRange(dodges,[],'20').length,0);
});
test('details preserve fractional penalty, escape strings, and explain missing coverage',async()=>{
  const output=await details(match({rr_performance_bonus:5,rr_penalty:.25,queue_id:'<img src=x>',is_placement_match:false}));
  assert.match(output,/Performance bonus/);assert.match(output,/0.25/);
  assert.ok(!output.includes('<img'));assert.match(output,/Placement match/);
  assert.match(await details(match({})),/unavailable/);
  assert.equal(await details({}), '');
});

test('stable API unknown movement sentinel is not displayed as a rank event',async()=>{
  const m=match({competitive_movement:'MOVEMENT_UNKNOWN'});
  assert.equal(m.myRRDetails.movement,null);
  assert.ok(!(await details(m)).includes('Competitive movement'));
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
    {match_id:'dodge',date:'2026-10-05T12:00:00Z',season:{short:'new',id:'act'},tier:{id:18},rr:14,last_change:-6,match_length:0},
    {match_id:'shield',date:'2026-10-06',season:{short:'new'},tier:{id:18},rr:0,last_change:-20,
      tier_before_update:{id:18},rr_before_update:0,was_derank_protected:true},
  ];
  const start=html.indexOf('        const history=(rrJ.data||rrJ).history||[];');
  const end=html.indexOf('\n        });',start)+'\n        });'.length;
  assert.ok(start>0&&end>start);
  const names=['_rrChangeByMatchId','_rrDetailsByMatchId','_preRRByMatchId','_preTierByMatchId',
    '_postRRByMatchId','_postTierByMatchId','_refundedRRByMatchId','_derankProtectedByMatchId'];
  const context=Object.fromEntries(names.map(name=>[name,{}]));
  Object.assign(context,{_rrDodges:[],rrJ:{data:{history:history.reverse()}},parseRRDetails:api.parseRRDetails,reportedRRStart:api.reportedRRStart,rrDodgeEntry:api.rrDodgeEntry});
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
  // The dodge is kept apart (it has no match), and only the dodge.
  assert.deepEqual(context._rrDodges.map(d=>[d.matchId,d.change,d.seasonId]),[['dodge',-6,'act']]);
});
