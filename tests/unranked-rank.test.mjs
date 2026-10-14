import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
function extract(start,end){const from=html.indexOf(start),to=html.indexOf(end,from);assert.ok(from>=0&&to>from);return html.slice(from,to);}
const icons=runInNewContext(extract('const RANK_ICONS=','\n/*')+'\n({rankIcon,RANK_ICONS})');
const ranks=runInNewContext(extract('function matchCardPlayerRank(', '\nfunction buildMatchCard(')+
  '\nmatchCardPlayerRank',{rrPositionFromElo:(elo,tier)=>({tier,rr:elo})});

test('all Unranked tier aliases use the official embedded small icon and existing large asset',()=>{
  const bytes=Buffer.from(icons.RANK_ICONS[0].split(',')[1],'base64');
  assert.equal(bytes.readUInt32BE(16),128);assert.equal(bytes.readUInt32BE(20),128);
  assert.ok(existsSync(new URL('../assets/ranks/0.png',import.meta.url)));
  for(const tier of [0,1,2,'0','1','2']){
    assert.match(icons.rankIcon(tier,16),/data:image\/png;base64/);
    assert.match(icons.rankIcon(tier,64),/src="\/assets\/ranks\/0.png"/);
  }
  assert.equal(icons.rankIcon(null),'');assert.equal(icons.rankIcon(undefined),'');
  assert.match(icons.rankIcon(12,64),/\/assets\/ranks\/12.png/);
});

test('confirmed Unranked match ranks show no inferred RR, including the placement that reveals a rank',()=>{
  let rank=ranks({myTierId:0,myRankKnown:true,myPreRR:null});
  assert.equal(rank.tier,0);assert.equal(rank.rr,null);
  rank=ranks({myTierId:12,myRRDetails:{beforeTier:0},myPreRR:900});
  assert.equal(rank.tier,0);assert.equal(rank.rr,null);
  assert.equal(ranks({myTierId:0,myRankKnown:false,myPreRR:null}),null);
  assert.equal(ranks({myTierId:12,myPreRR:null}),null);
  assert.equal(ranks({myTierId:12,myPreRR:950}).tier,12);
});
