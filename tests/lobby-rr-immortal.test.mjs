import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {lobbyRankText,lobbyRR,lobbyTeamsChartRows,lobbyTeamsGapLabel,tierRR} from '../src/engine/core.mjs';
import {closeRenderer,renderHtml} from './helpers/react-render.mjs';

// Lobby averages come from tier ids only, so their RR is the average's decimal
// part. From Immortal 1 up there are no 100-RR divisions (RR accumulates from
// the Immortal 1 floor; Immortal 2/3 and Radiant are leaderboard cutoffs), so
// an average there shows its rank without RR everywhere (decision 20 Nov 2026).

after(closeRenderer);
const text=html=>html.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ');

test('lobby RR shows through Ascendant 3 and is hidden from Immortal 1 up',()=>{
  assert.equal(lobbyRR(tierRR(23.4)),90);
  assert.equal(lobbyRankText(23.4),'Ascendant 3 (90 RR)');
  assert.equal(lobbyRankText(23.4,true),'Asc 3 (90 RR)');
  // 23.5 is the Immortal 1 edge: tierRR rounds it to tier 24.
  assert.equal(lobbyRR(tierRR(23.5)),null);
  assert.equal(lobbyRankText(23.5),'Immortal 1');
  assert.equal(lobbyRankText(25.3),'Immortal 2');
  assert.equal(lobbyRankText(26.8,true),'Rad');
  assert.equal(lobbyRR(null),null);
});

test('the team gap keeps RR below Immortal and only its direction once either side is Immortal+',()=>{
  const rows=lobbyTeamsChartRows([
    {tier:22,total:2,teamRankSum:44,teamRankCount:2,enemyRankSum:44.6,enemyRankCount:2},
    {tier:24,total:2,teamRankSum:46.6,teamRankCount:2,enemyRankSum:47.4,enemyRankCount:2},
    {tier:25,total:1,teamRankSum:25.4,teamRankCount:1,enemyRankSum:24.9,enemyRankCount:1},
  ]);
  assert.deepEqual(rows.map(r=>r.gapInRR),[true,false,false]);
  assert.deepEqual(rows.map(r=>lobbyTeamsGapLabel(r.gap,r.gapInRR)),['Enemy +30 RR','Enemy higher','Team higher']);
  assert.equal(lobbyTeamsGapLabel(0,false),'Even');
  assert.equal(lobbyTeamsGapLabel(null,false),'—');
});

test('the Overview lobby rank card drops the RR figure and bar for an Immortal+ average',async()=>{
  const statMatches=Array.from({length:6},()=>({partySize:1,avgRank:25.6}));
  const html=await renderHtml('/src/app/pages/Overview.jsx','LobbyRankCard',{s:{overviewStats:{overall:25.6,overallRR:tierRR(25.6)},statMatches}});
  const hero=html.slice(html.indexOf('data-slot="lobby-rank-hero"'),html.indexOf('data-slot="separator"'));
  assert.match(text(hero),/Immortal 3 Across 6 rated lobbies/);
  assert.doesNotMatch(hero,/RR|data-slot="progress"/);
  // Below Immortal the RR and bar stay.
  const asc=await renderHtml('/src/app/pages/Overview.jsx','LobbyRankCard',{s:{overviewStats:{overall:22.3,overallRR:tierRR(22.3)},statMatches:[]}});
  assert.match(text(asc),/Ascendant 2 80 RR/);
  assert.match(asc,/data-slot="progress"/);
});

test('table lobby values show RR below Immortal only',async()=>{
  const imm=await renderHtml('/src/app/shared.jsx','LobbyValue',{sum:48,count:2});
  assert.match(text(imm),/^ Immortal 1 $/);
  assert.match(imm,/title="Immortal 1"/);
  const asc=await renderHtml('/src/app/shared.jsx','LobbyValue',{sum:44,count:2});
  assert.match(text(asc),/Ascendant 2 \(50 RR\)/);
});
