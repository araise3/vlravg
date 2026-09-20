import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const extract=(start,end)=>{
  const from=html.indexOf(start),to=html.indexOf(end,from);
  assert.ok(from>=0&&to>from);
  return html.slice(from,to);
};
const {ratedTeamRank,buildKdRankBuckets}=runInNewContext(
  extract('function ratedTeamRank(', '\nfunction processMatch(')+
  extract('function buildKdRankBuckets(', '\n/* ── RR GAINS')+
  '\n({ratedTeamRank,buildKdRankBuckets})');

test('team rank uses rated players on the correct side',()=>{
  const players=[
    {team_id:'blue',_tier:3},{team_id:'blue',_tier:6},{team_id:'blue',_tier:0},
    {team_id:'red',_tier:9},{team_id:'red',_tier:12},{team_id:null,_tier:27},
  ];
  assert.equal(ratedTeamRank(players,'blue',true),4.5);
  assert.equal(ratedTeamRank(players,'blue',false),10.5);
  assert.equal(ratedTeamRank(players,null,true),null);
});

test('lobby rank groups average each match team rank equally',()=>{
  const matches=[
    {myStats:{kills:1,deaths:1},avgTeamRank:5,avgEnemyRank:8,won:true},
    {myStats:{kills:1,deaths:1},avgTeamRank:15,avgEnemyRank:20,won:false},
  ];
  const rows=buildKdRankBuckets(()=>({tier:12,label:'Gold 1'}),{matches});
  assert.equal(rows.length,1);
  assert.equal(rows[0].teamRankSum/rows[0].teamRankCount,10);
  assert.equal(rows[0].enemyRankSum/rows[0].enemyRankCount,14);
});
