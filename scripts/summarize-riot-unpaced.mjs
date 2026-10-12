import { readFile, writeFile } from 'node:fs/promises';
const load = async path => JSON.parse(await readFile(path,'utf8'));
const run = await load('.local/riot-unpaced-results.json');
const baseline = await load('docs/riot-benchmark-results.json');
const percentile = (values,p) => {
  const sorted = [...values].sort((a,b)=>a-b);
  return sorted.length ? sorted[Math.max(0,Math.ceil(sorted.length*p)-1)] : null;
};
const metrics = run.reports.flatMap(r=>r.report.metrics);
const stages = [...new Set(run.reports.map(r=>r.concurrency))];
let doc = '# Unpaced Riot remote-session benchmark\n\n';
doc += `Run started ${run.startedAt}. All requests originated from the isolated Cloudflare Pages preview, using the existing dedicated Riot account. No sleep, pacing or retry was used. The frozen 24-player PC sample is the same as the earlier Henrik comparison.\n\n`;
doc += 'One cookie renewal, identity check and entitlement issuance were shared by each three-player batch. Content was fetched once per batch. Tokens were held only in that request; this is session reuse within a batch, not a persistent session across all batches. Data workload: current MMR, 20 history IDs, 20 RR updates and up to ten full competitive match details per player. There were no new Henrik requests; comparison uses the saved earlier benchmark.\n\n';
const rejected = run.reports.find(r=>r.report.rateLimited);
if (rejected) {
  const m = rejected.report.metrics.find(m=>m.status===429);
  const successes = run.reports.reduce((n,r)=>n+r.report.dataSuccesses,0);
  const page = rejected.report.pages.find(p=>p.requested>p.returned && p.detailWallMs!==null);
  doc += `The first limit was observed on **${m.endpoint}**${page ? ` in **${page.region}**` : ''}, in batch ${rejected.batch+1}, at concurrency ${rejected.concurrency}. Before that rejection, ${successes} data requests succeeded. The entire run took ${(run.elapsedMs/1000).toFixed(2)} seconds, including session setup and client-to-preview overhead. This is a measured rejection point for this account/deployment/workload, not proof of a fixed ${successes}-per-minute quota. The planned two/four-concurrent stages were not run after the rejection.\n\n`;
}
doc += '| Concurrent requests | Batches | Successful data requests | Data wall time, s | Data requests/s | Whole stage requests/s | 429s |\n| ---: | ---: | ---: | ---: | ---: | ---: | ---: |\n';
for (const c of stages) {
  const rows = run.reports.filter(r=>r.concurrency===c).map(r=>r.report);
  const n = rows.reduce((n,r)=>n+r.dataSuccesses,0), wall=rows.reduce((n,r)=>n+r.dataWallMs,0);
  const stage = run.stageTimes?.find(s=>s.concurrency===c);
  doc += `| ${c} | ${rows.length} | ${n} | ${(wall/1000).toFixed(2)} | ${(n*1000/wall).toFixed(2)} | ${stage ? (n*1000/stage.clientWallMs).toFixed(2) : 'unfinished'} | ${rows.flatMap(r=>r.metrics).filter(m=>m.status===429).length} |\n`;
}
doc += '\nData wall time includes scheduling and transfer, and excludes authentication, content and client-to-preview gaps between batches. Whole-stage rate includes those costs. These are observed finite-workload rates, not a proven sustainable maximum or an extrapolation to hourly capacity.\n\n';
doc += '| Endpoint | Earlier paced Riot median/p95, ms | Unpaced sequential Riot median/p95, ms | Unpaced four concurrent Riot median/p95, ms | Earlier Henrik proxy median/p95, ms |\n| --- | ---: | ---: | ---: | ---: |\n';
for (const endpoint of ['rank','history','rr','detail']) {
  const describe = rows => {
    const a=rows.filter(m=>m.endpoint===endpoint && m.status===200).map(m=>m.elapsedMs);
    return a.length ? `${percentile(a,.5)} / ${percentile(a,.95)} (n=${a.length})` : '—';
  };
  const earlier=baseline.main.reports.flatMap(r=>r.metrics);
  doc += `| ${endpoint} | ${describe(earlier.filter(m=>m.provider==='riot'))} | ${describe(run.reports.filter(r=>r.concurrency===1).flatMap(r=>r.report.metrics))} | ${describe(run.reports.filter(r=>r.concurrency===4).flatMap(r=>r.report.metrics))} | ${describe(earlier.filter(m=>m.provider==='henrik-proxy'))} |\n`;
}
doc += '\nHistory responses are not equal work: Riot returns IDs; Henrik returns ten full match records. Earlier Henrik numbers include the production proxy, its cache, quota pacing and persistence. Individual request transfer times in the earlier benchmark already excluded its explicit 500 ms pause. Removing the pause affects workflow duration, not necessarily individual request latency. Planned concurrency stages are ascending; if multiple stages complete, repeat-request warming can affect the comparison.\n\n';
doc += '| Region / sample | Earlier Henrik full-history response, ms | Earlier Riot detail sum, ms / count | New sequential Riot detail wall, ms / count | New four-concurrent Riot detail wall, ms / count |\n| --- | ---: | ---: | ---: | ---: |\n';
for (const old of baseline.deep.reports) {
  const henrik=old.metrics.find(m=>m.provider==='henrik-proxy'&&m.endpoint==='history');
  const find = c => run.reports.filter(r=>r.concurrency===c).flatMap(r=>r.report.pages).find(p=>p.playerHash===old.playerHash);
  const describe=p=>p ? `${p.detailWallMs} / ${p.returned}` : '—';
  doc += `| ${old.region} / ${old.sample} | ${henrik?.elapsedMs??'—'} | ${old.fullPage?.detailTransferMs??'—'} / ${old.fullPage?.returned??0} | ${describe(find(1))} | ${describe(find(4))} |\n`;
}
doc += '\nDetail wall time begins at the first detail dispatch and ends at the last completion for that player; batches may interleave players. It excludes rank/history/RR setup. The new run fetches the first ten accessible recent matches; the old deep check fetched up to ten shared Riot/Henrik matches. Different counts or match sets are not an exact page-for-page speed comparison.\n\n';
const failures=metrics.filter(m=>m.status!==200 && !(m.endpoint==='auth'&&m.status>=300&&m.status<400));
doc += `Completed ${metrics.length} upstream calls, with ${metrics.filter(m=>m.status===429).length} HTTP 429s and ${failures.length} rejected/network calls. `;
doc += run.error ? `The client stopped: ${run.error}. ` : '';
doc += run.stopped ? 'The workload stopped on the first rejected request; already in-flight calls were allowed to finish.\n\n' : 'All saved batches completed.\n\n';
doc += 'The earlier paced run saved 489 Riot calls with zero 429s; this unpaced run reached a rejection. The earlier Henrik-backed proxy saved two 429s, plus one separately recorded 429. Those phases and workloads differ, and the proxy shares quota with live visitors, so they do not provide a numeric Henrik capacity ceiling to compare with this run. This experiment does not establish authentication-renewal capacity, longer-window limits, per-account/IP/region partitioning, or long-term session reliability.\n';
await writeFile('docs/riot-unpaced-benchmark.md',doc);
await writeFile('docs/riot-unpaced-results.json',JSON.stringify(run,null,2));
console.log(JSON.stringify({batches:run.reports.length,requests:metrics.length,rateLimited:metrics.filter(m=>m.status===429).length,failures:failures.length}));
