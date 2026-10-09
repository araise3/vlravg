import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const start=html.indexOf('function performanceComparisonRows(');
const end=html.indexOf('let performanceDnaRange=',start);
const {rows,path}=runInNewContext(html.slice(start,end)+'\n({rows:performanceComparisonRows,path:performanceDnaPath})');
const game=(acs,ps,players,startedAtMs=1)=>({startedAtMs,myStats:{acs,performanceScore:ps},
  players:players.map(([a,p])=>({_acs:a,_performanceScore:p}))});

test('different raw scales compare by relative position within each game',()=>{
  const match=game(200,100,[[0,0],[50,100],[100,200],[150,300],[200,400]]);
  const [row]=rows([match]);
  assert.equal(row.acsPercentile,100);assert.equal(row.psPercentile,25);assert.equal(row.gap,-75);
  const scaled=game(200,1100,match.players.map(p=>[p._acs,1000+p._performanceScore]));
  assert.equal(rows([scaled])[0].gap,row.gap,'adding a constant to PS must not change relative standing');
});

test('ties share their mid-rank, all ties land at 50, and zero is valid',()=>{
  const [row]=rows([game(0,0,[[0,0],[0,0],[100,100]])]);
  assert.equal(row.acsPercentile,25);assert.equal(row.psPercentile,25);assert.equal(row.gap,0);
  const [tied]=rows([game(200,300,[[200,300],[200,300],[200,300]])]);
  assert.equal(tied.acsPercentile,50);assert.equal(tied.psPercentile,50);
});

test('both percentiles use the same measured players; missing scores and singleton lobbies are unavailable',()=>{
  const [partial]=rows([game(100,400,[[100,400],[200,200],[500,null],[null,900]])]);
  assert.equal(partial.acsCount,2);assert.equal(partial.psCount,2);
  assert.equal(partial.acsPercentile,0);assert.equal(partial.psPercentile,100);
  for(const match of [game(100,null,[[100,null],[200,300]]),game(100,300,[[100,300]]),
    game(100,NaN,[[100,NaN],[200,300]])]){
    const [row]=rows([match]);
    assert.equal(row.gap,null);assert.equal(row.acsPercentile,null);assert.equal(row.psPercentile,null);
  }
});

test('games remain chronological without mutating input or dropping unavailable matches',()=>{
  const input=[game(100,300,[[100,300],[200,200]],3),{startedAtMs:2},game(200,200,[[100,300],[200,200]],1)];
  const result=rows(input);
  assert.deepEqual(Array.from(result,r=>r.m.startedAtMs),[1,2,3]);
  assert.deepEqual(input.map(m=>m.startedAtMs),[3,2,1]);
  assert.deepEqual(Array.from(result,r=>r.game),[1,2,3]);
});

test('strand curves break across unavailable games and stay within endpoint values',()=>{
  const result=path([{score:0},{score:100},{score:null},{score:25},{score:75}],'score',i=>i*10,v=>v);
  assert.equal(result,'M0,0 C5,0 5,100 10,100M30,25 C35,25 35,75 40,75');
  assert.equal(path([{score:null}],'score',i=>i,v=>v),'');
});
