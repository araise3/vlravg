import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {gunzipSync} from 'node:zlib';

const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const section=(from,to)=>html.slice(html.indexOf(from),html.indexOf(to,html.indexOf(from)));
const ctx={};
const realDeaths=html.slice(html.indexOf('const POST_ROUND_PHASE_MS'),html.indexOf('\n}\n',html.indexOf('function computeRealDeaths('))+3);
runInNewContext(realDeaths+section('// Per-round stats for one player', '// ─────────────────')+'\nObject.assign(this,{computeRoundStats,extractStats,trackerFixed1,roundHalfEven});',ctx);
const {computeRoundStats,extractStats,trackerFixed1,roundHalfEven}=ctx;

const P=(puuid,team)=>({puuid,team});
const roster=[
  {puuid:'me',team_id:'Red'},{puuid:'mate',team_id:'Red'},
  {puuid:'e1',team_id:'Blue'},{puuid:'e2',team_id:'Blue'},
];
const kill=(round,t,killer,victim,assistants=[])=>({
  round,time_in_round_in_ms:t,
  killer:{puuid:killer},victim:{puuid:victim},
  assistants:assistants.map(puuid=>({puuid})),
});
const round=(events=[])=>({stats:[{player:P('me','Red'),damage_events:events}]});
const hit=(to,damage)=>({player:{puuid:to},damage});

test('ADR counts only damage to enemies, not friendly fire or self-damage',()=>{
  const m={players:roster,rounds:[round([hit('e1',150),hit('mate',40)]),round([hit('me',30),hit('e2',100)])],kills:[]};
  const rs=computeRoundStats(m,'me');
  assert.equal(rs.enemyDamage,250);
  // Henrik's summary total (Riot's) also carries the 70 friendly/self damage.
  const stats=extractStats({stats:{kills:0,deaths:0,score:0,damage:{dealt:320}}},2,rs);
  assert.equal(stats.dmg,250);
  assert.equal(stats.adr,125);
});

test('a player who dealt no damage gets 0, not the summary fallback',()=>{
  const m={players:roster,rounds:[round([]),round([])],kills:[]};
  const stats=extractStats({stats:{kills:0,deaths:0,damage:{dealt:12}}},2,computeRoundStats(m,'me'));
  assert.equal(stats.dmg,0);
  assert.equal(stats.adr,0);
});

test('payloads without round data fall back to the summary damage and leave KAST unknown',()=>{
  assert.equal(computeRoundStats({players:roster},'me'),null);
  const stats=extractStats({stats:{kills:3,deaths:1,score:600,damage:{dealt:400}}},4,null);
  assert.equal(stats.adr,100);
  assert.equal(stats.kast,null);
  assert.equal(stats.kastRounds,null);
});

test('KAST credits kill, assist, survival and a trade within 3 s',()=>{
  const m={players:roster,rounds:Array.from({length:7},()=>round()),kills:[
    // r0 kill, then died untraded
    kill(0,1000,'me','e1'),kill(0,5000,'e2','me'),
    // r1 assist, died untraded
    kill(1,1000,'mate','e1',['me']),kill(1,9000,'e2','me'),
    // r2 survived without any kill
    kill(2,1000,'mate','e1'),
    // r3 died, teammate traded the killer exactly 3 s later
    kill(3,2000,'e1','me'),kill(3,5000,'mate','e1'),
    // r4 died, traded 3.001 s later: too late
    kill(4,2000,'e1','me'),kill(4,5001,'mate','e1'),
    // r5 died, killer later died to his own team (not a trade)
    kill(5,2000,'e1','me'),kill(5,3000,'e2','e1'),
    // r6 killed self by falling: a death, and no kill credit
    {...kill(6,2000,'me','me'),weapon:{type:'Fall'}},
  ]};
  const rs=computeRoundStats(m,'me');
  assert.equal(rs.rounds,7);
  assert.equal(rs.kastRounds,4);
  const stats=extractStats({stats:{kills:1,deaths:6}},7,rs);
  assert.equal(stats.kast,57);
  assert.equal(stats.kastTotalRounds,7);
});

test('a trade credits only the killer\'s most recent victim',()=>{
  // Summit r20 (d0df12e1): e1 kills me, then kills mate, then dies to a
  // teammate within 3 s of my death. Tracker credits mate, not me.
  const m={players:[...roster,{puuid:'mate2',team_id:'Red'}],rounds:[round(),round()],kills:[
    kill(0,17846,'e1','me'),kill(0,19232,'e1','mate'),kill(0,20721,'mate2','e1'),
    // r1 control: a teammate dies to a different enemy in between; still my trade (Summit r3)
    kill(1,10000,'e1','me'),kill(1,11000,'e2','mate'),kill(1,12000,'mate2','e1'),
  ]};
  assert.equal(computeRoundStats(m,'me').kastRounds,1);
  assert.equal(computeRoundStats(m,'mate').kastRounds,1);
});

test('same-millisecond kills: list order decides the last victim, the trade instant does not count',()=>{
  const roster3=[...roster,{puuid:'mate2',team_id:'Red'}];
  // Summit r13 (cdcacc5a): wrath kills LuhBirdo, then erenmitB, both at
  // 10383; traded at 12061. Tracker credits the later entry only.
  const a={players:roster3,rounds:[round()],kills:[kill(0,10383,'e1','me'),kill(0,10383,'e1','mate'),kill(0,12061,'mate2','e1')]};
  assert.equal(computeRoundStats(a,'me').kastRounds,0);
  assert.equal(computeRoundStats(a,'mate').kastRounds,1);
  // Sunset r8 (6e2a5fec): 1ce kills aaapowerline at 20990, then kills Doyle
  // in the same millisecond as dying (23851). Tracker credits aaapowerline.
  const b={players:roster3,rounds:[round()],kills:[kill(0,20990,'e1','me'),kill(0,23851,'e1','mate'),kill(0,23851,'mate2','e1')]};
  assert.equal(computeRoundStats(b,'me').kastRounds,1);
  assert.equal(computeRoundStats(b,'mate').kastRounds,0);
});

test('a kill in the same millisecond as the death is not a trade',()=>{
  // Sunset r15 (977db87f): yuno kills WASHEDMANNY42 and dies to Jobless at 11833.
  const m={players:roster,rounds:[round()],kills:[kill(0,11833,'e1','me'),kill(0,11833,'mate','e1')]};
  assert.equal(computeRoundStats(m,'me').kastRounds,0);
});

test('a spike explosion is not a death, and an assist on a spike self-kill earns nothing',()=>{
  const bomb=(round,t,victim,assistants=[])=>({...kill(round,t,victim,victim,assistants),weapon:{type:'Bomb'}});
  const m={players:roster,rounds:[round(),round()],kills:[
    // r0 (560e631e r14, Ria): the spike kills me at detonation; tracker counts the round
    bomb(0,67154,'me'),
    // r1 (4415ea0e r10, axl): my only credit is an "assist" on an enemy's spike death
    kill(1,60000,'e1','me'),bomb(1,68418,'e1',['me']),
  ]};
  assert.equal(computeRoundStats(m,'me').kastRounds,1);
});

test('a player absent from the round does not survive it; Riot\'s was_afk alone decides nothing',()=>{
  // e707c572 (Yan): was_afk is set on r9, where Yan is in every snapshot,
  // and missing on r10, where Yan is in none. Tracker drops r10, counts r9.
  const at=(alive)=>alive.map(puuid=>({player:{puuid}}));
  const statsRow=was_afk=>({stats:[{player:{puuid:'me'},was_afk,damage_events:[]}]});
  const m={players:roster,rounds:[statsRow(true),statsRow(false),statsRow(false)],kills:[
    {...kill(0,4621,'mate','e1'),player_locations:at(['me','mate','e1','e2'])},
    {...kill(1,19133,'mate','e1'),player_locations:at(['mate','e1','e2'])},
    // r2: absent, but a kill still counts
    {...kill(2,5000,'me','e1'),player_locations:at(['mate','e1','e2'])},
  ]};
  assert.equal(computeRoundStats(m,'me').kastRounds,2);
});

test('a player revived and alive at round end counts as survived',()=>{
  // Sunset r8 (c0790deb): an Omen killed at 2.5 s, revived by their Sage,
  // seen alive in later kill snapshots. Tracker counts the round.
  const players=[{puuid:'me',team_id:'Red',agent:{name:'Omen'}},{puuid:'sage',team_id:'Red',agent:{name:'Sage'}},
    {puuid:'e1',team_id:'Blue',agent:{name:'Jett'}},{puuid:'e2',team_id:'Blue',agent:{name:'Sova'}}];
  const at=(alive)=>alive.map(puuid=>({player:{puuid}}));
  const m={players,rounds:[{result:'Elimination',winning_team:'Red',stats:[]},{result:'Elimination',winning_team:'Blue',stats:[]}],kills:[
    {...kill(0,2455,'e1','me'),player_locations:at(['sage','e1','e2'])},
    {...kill(0,24382,'sage','e1'),player_locations:at(['me','sage','e2'])},
    {...kill(0,28981,'me','e2'),player_locations:at(['me','sage'])},
    // r1: same start, but never seen again: the death stands
    {...kill(1,2455,'e1','me'),player_locations:at(['sage','e1','e2'])},
    {...kill(1,24382,'e1','sage'),player_locations:at(['e1','e2'])},
  ]};
  assert.equal(computeRoundStats(m,'me').kastRounds,1);
});

test('display rounding follows tracker: ADR via 2 decimals, KAST .5 to even',()=>{
  // Blind-test rows: BayHarborButcher 2855/21, potok 3761/22, トリスタン 3224/22.
  assert.equal(trackerFixed1(2855/21),'135.9');
  assert.equal(trackerFixed1(3761/22),'170.9');
  assert.equal(trackerFixed1(3224/22),'146.6');
  assert.equal(trackerFixed1(197.25),'197.3');
  // JuliONline 15/24 on Bind (11962da8).
  assert.equal(roundHalfEven(62.5),62);
  assert.equal(roundHalfEven(63.5),64);
  assert.equal(roundHalfEven(73.9),74);
  assert.equal(roundHalfEven(61.5),62);
});

test('overview KAST weights by rounds and ignores matches without round data',()=>{
  const elements=new Map(['sg-adr','sg-kast','sg-kast-pill'].map(id=>[id,{}]));
  const context={document:{getElementById:id=>elements.get(id)},trackerFixed1,roundHalfEven,statsPanelMatches:[
    {myStats:{adr:100,dmg:1000,rounds_played:10,kastRounds:5,kastTotalRounds:10}},
    {myStats:{adr:200,dmg:6000,rounds_played:30,kastRounds:27,kastTotalRounds:30}},
    {myStats:{adr:150,dmg:3000,rounds_played:20,kastRounds:null,kastTotalRounds:null}},
  ]};
  runInNewContext(section('  // Avg ADR', '  renderRankByRankCard();'),context);
  assert.equal(elements.get('sg-adr').textContent,'166.7');
  assert.equal(elements.get('sg-kast').textContent,'80%');
  assert.match(elements.get('sg-kast-pill').title,/2 of 3 matches/);
});

test('thirty-three Nov 2026 matches reproduce tracker.gg ADR and KAST on every row',()=>{
  const {matches}=JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/tracker-adr-kast-2026-11.json.gz',import.meta.url))).toString('utf8'));
  assert.equal(matches.length,33);
  assert.equal(matches.filter(m=>m.blind===1).length,4);
  assert.equal(matches.filter(m=>m.blind===2).length,4);
  assert.equal(matches.filter(m=>m.blind===3).length,15);
  const off=[];
  let rawDiffers=0;
  for(const m of matches){
    const R=m.rounds.length;
    for(const p of m.players){
      const [adr,kast]=m.tracker[p.puuid];
      const stats=extractStats(p,R,computeRoundStats(m,p.puuid));
      if(+trackerFixed1(stats.dmg/R)!==adr)off.push(`${m.label}/${p.name}:adr`);
      if(stats.kast!==kast)off.push(`${m.label}/${p.name}:kast ${stats.kast} vs ${kast}`);
      if(+(p.stats.damage.dealt/R).toFixed(1)!==adr)rawDiffers++;
    }
  }
  assert.deepEqual(off,[]);
  // The old summary-total ADR misses tracker on the friendly-fire rows.
  assert.ok(rawDiffers>=15,`raw dealt differs on ${rawDiffers} rows`);
});
