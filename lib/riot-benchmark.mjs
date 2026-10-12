import { runRemoteProbe } from './riot-remote-probe.mjs';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const SAMPLE_SQL = `SELECT puuid,region,platform,name,tag FROM (
  SELECT puuid,region,platform,name,tag,updated_at,
    ROW_NUMBER() OVER (PARTITION BY region ORDER BY puuid) AS regional_order
  FROM rr_players WHERE platform='pc' AND region IN ('eu','na','ap','kr')
    AND name IS NOT NULL AND tag IS NOT NULL
) ORDER BY regional_order,region,puuid LIMIT 24`;

export function compareDetails(riot, henrik) {
  const rp = riot?.players || [], hp = henrik?.players || [];
  const ids = new Set(hp.map(p => p.puuid));
  const paired = rp.filter(p => ids.has(p.subject));
  const mismatches = { kills: 0, deaths: 0, assists: 0, score: 0 };
  const statComparisons = { kills: 0, deaths: 0, assists: 0, score: 0 };
  let damageCompared=0,damageMismatches=0,noSelfDamageMismatches=0,tierCompared=0,tierMismatches=0;
  const damageMismatchSamples=[];
  let compared = 0;
  for (const p of paired) {
    const h = hp.find(h => h.puuid === p.subject);
    if (!p.stats || !h.stats) continue;
    compared++;
    for (const field of Object.keys(mismatches)) {
      if (typeof p.stats[field] === 'number' && typeof h.stats[field] === 'number') {
        statComparisons[field]++;
        if (p.stats[field] !== h.stats[field]) mismatches[field]++;
      }
    }
    if(Array.isArray(p.roundDamage)&&typeof h.stats.damage?.dealt==='number') {
      damageCompared++;
      const total=p.roundDamage.reduce((n,d)=>n+d.damage,0);
      const noSelfTotal=p.roundDamage.filter(d=>d.receiver!==p.subject).reduce((n,d)=>n+d.damage,0);
      if(noSelfTotal!==h.stats.damage.dealt)noSelfDamageMismatches++;
      if(total!==h.stats.damage.dealt){
        damageMismatches++;
        const enemyTotal=p.roundDamage.filter(d=>rp.find(x=>x.subject===d.receiver)?.teamId!==p.teamId)
          .reduce((n,d)=>n+d.damage,0);
        damageMismatchSamples.push({rawTotal:total,noSelfTotal,enemyTotal,henrikTotal:h.stats.damage.dealt});
      }
    }
    if(typeof p.competitiveTier==='number'&&typeof h.tier?.id==='number') {
      tierCompared++;if(p.competitiveTier!==h.tier.id)tierMismatches++;
    }
  }
  const rr = riot?.roundResults || [], hr = henrik?.rounds || [];
  return { riotPlayers: rp.length, henrikPlayers: hp.length, sharedPlayers: paired.length,
    statPlayersCompared: compared, statComparisons, statMismatches: mismatches,
    damageCompared,damageMismatches,noSelfDamageMismatches,damageMismatchSamples,tierCompared,tierMismatches,
    riotRounds: rr.length, henrikRounds: hr.length,
    riotKills: riot?.kills?.length ?? null, henrikKills: henrik?.kills?.length ?? null,
    riotPartyIds: rp.some(p => !!p.partyId), henrikPartyIds: hp.some(p => !!p.party_id),
    riotSeason: !!riot?.matchInfo?.seasonId, henrikSeason: !!henrik?.metadata?.season?.id,
    riotRoundPlayerStats: rr.some(r => Array.isArray(r.playerStats) && r.playerStats.length > 0),
    henrikRoundPlayerStats: hr.some(r => Array.isArray(r.stats) && r.stats.length > 0),
    riotObserverFlags: rp.some(p => typeof p.isObserver === 'boolean'),
    henrikObserverFlags: hp.some(p => typeof p.is_observer === 'boolean'),
    riotPartyPenalties: !!riot?.matchInfo?.partyRRPenalties,
    henrikPartyPenalties: Array.isArray(henrik?.metadata?.party_rr_penaltys),
    riotRoundTimings: rr.some(r=>typeof r.roundResult==='string'),
    henrikRoundTimings: hr.some(r=>typeof r.result==='string'),
    riotHitLocations: rr.some(r=>(r.playerStats||[]).some(p=>(p.damage||[]).some(d=>typeof d.headshots==='number'))),
    henrikHitLocations: hp.some(p=>typeof (p.stats?.shots?.head??p.stats?.headshots??p.headshots)==='number'),
    riotKillFields:Object.keys(riot?.kills?.[0]||{}),henrikKillFields:Object.keys(henrik?.kills?.[0]||{}),
    riotRoundFields:Object.keys(rr[0]||{}),henrikRoundFields:Object.keys(hr[0]||{}),
    riotPlayerFields:Object.keys(rp[0]||{}),henrikPlayerFields:Object.keys(hp[0]||{}),
    henrikStatsFields:Object.keys(hp[0]?.stats||{}) };
}

// One bounded sample per request; secrets and raw records remain request-local.
export async function benchmarkPlayer(env, player, index, fetcher = fetch, pause = ms => new Promise(r => setTimeout(r, ms)), deep = false) {
  const metrics = [], raw = new Map();
  let riotHeaders, rateLimited = false;
  async function measured(url, options = {}) {
    if (rateLimited) throw Error('Rate limited');
    await pause(500);
    const provider = url.startsWith('https://vlravg.com/') ? 'henrik-proxy' : 'riot';
    const path = new URL(url).pathname;
    const endpoint = path.includes('match-history') ? 'history' : path.includes('competitiveupdates') ? 'rr'
      : path.includes('match-details') || path.includes('match-detail') ? 'detail'
      : path.includes('/api/history/') ? 'history' : path.includes('mmr-history') ? 'rr'
      : path.includes('/mmr/') || path.includes('/rank/') ? 'rank'
      : path.includes('/account-') ? 'account' : path.includes('content-service') ? 'content' : 'auth';
    if (provider === 'riot' && options.headers?.['X-Riot-Entitlements-JWT']) riotHeaders = options.headers;
    const start = performance.now();
    const response = await fetcher(url, { ...options, redirect: 'manual', signal: AbortSignal.timeout(15000) });
    const bytes = new Uint8Array(await response.arrayBuffer());
    metrics.push({ provider, endpoint, status: response.status, elapsedMs: Math.round(performance.now() - start),
      bytes: bytes.length, cache: response.headers.get('X-Proxy-Cache') || 'unknown',
      rateHeadersPresent: ['x-ratelimit-limit','x-ratelimit-remaining','ratelimit','retry-after'].some(k => response.headers.has(k)) });
    if (response.status === 429) {
      rateLimited = true;
      try {
        const retry=JSON.parse(new TextDecoder().decode(bytes)).retryAfterMs;
        if(Number.isFinite(retry)&&retry>0)metrics.at(-1).retryAfterMs=retry;
      }catch{}
    }
    return new Response(bytes.length ? bytes : null, { status: response.status, headers: response.headers });
  }
  const started = Date.now();
  const direct = await runRemoteProbe({ ...env, RIOT_SHARD: player.region, RIOT_TARGET_PUUID: player.puuid },
    'player', measured, (endpoint, data) => raw.set(endpoint, data));
  const report = { sample: index, region: player.region, directOk: direct.ok, metrics, elapsedMs: 0,
    rateLimited: false, notes: [] };
  async function henrik(label, path) {
    try {
      const response = await measured('https://vlravg.com/api/' + path);
      if (!response.ok) { report.notes.push(`${label}: HTTP ${response.status}`); return null; }
      const data = await response.json();
      return data.data;
    } catch { report.notes.push(`${label}: request failed`); return null; }
  }
  if (!rateLimited) {
    const account = await henrik('account', `account-by-puuid/${player.puuid}`);
    if (account?.puuid?.toLowerCase() === player.puuid.toLowerCase() && account.name && account.tag) {
      const identity = `${player.region}/pc/${encodeURIComponent(account.name)}/${encodeURIComponent(account.tag)}`;
      const rank = await henrik('rank', `rank/${identity}`);
      const rr = await henrik('rr', `mmr-history-by-puuid/${player.region}/pc/${player.puuid}`);
      const history = await henrik('history', `history/${identity}?mode=competitive&size=10&start=0`);
      const riotHistory = raw.get('history-competitive')?.History || [];
      const riotUpdates = raw.get('competitive-updates')?.Matches || [];
      const hm = Array.isArray(history) ? history : [];
      const hu = Array.isArray(rr) ? rr : rr?.history || [];
      const shared = riotHistory.filter(m => hm.some(h => h.metadata?.match_id === m.MatchID));
      report.coverage = { riotHistoryTotal: raw.get('history-competitive')?.Total ?? null,
        riotRecentIds: riotHistory.length, henrikRecentFullMatches: hm.length,
        sharedRecentMatches: shared.length, riotRR: riotUpdates.length, henrikPersistedRR: hu.length };
      const commonRR = riotUpdates.filter(r => hu.some(h => h.match_id === r.MatchID));
      let rrComparable = 0, rrMismatch = 0, shieldCompared=0,shieldMismatch=0,refundCompared=0,refundMismatch=0;
      for (const r of commonRR) {
        const h = hu.find(h => h.match_id === r.MatchID);
        if (typeof r.RankedRatingEarned === 'number' && typeof h.last_change === 'number') {
          rrComparable++; if (r.RankedRatingEarned !== h.last_change) rrMismatch++;
        }
        if(typeof r.WasDerankProtected==='boolean'&&typeof h.was_derank_protected==='boolean') {
          shieldCompared++;if(r.WasDerankProtected!==h.was_derank_protected)shieldMismatch++;
        }
        if(typeof r.RankedRatingRefundApplied==='number'&&typeof h.refunded_rr==='number') {
          refundCompared++;if(r.RankedRatingRefundApplied!==h.refunded_rr)refundMismatch++;
        }
      }
      report.rrParity = { commonMatches: commonRR.length, comparable: rrComparable, mismatches: rrMismatch,
        shieldCompared,shieldMismatch,refundCompared,refundMismatch,
        riotShieldField: riotUpdates.some(r => Object.hasOwn(r, 'WasDerankProtected')),
        henrikShieldField: hu.some(r => Object.hasOwn(r, 'was_derank_protected')),
        riotRefundField: riotUpdates.some(r => Object.hasOwn(r, 'RankedRatingRefundApplied')),
        henrikRefundField: hu.some(r => Object.hasOwn(r, 'refunded_rr')),
        riotEntryFields: Object.keys(riotUpdates[0]||{}), henrikEntryFields:Object.keys(hu[0]||{}) };
      const seasons = raw.get('content')?.Seasons || [];
      const active = seasons.find(s => s.IsActive && s.Type === 'act')?.ID;
      const current = raw.get('mmr')?.QueueSkills?.competitive?.SeasonalInfoBySeasonID?.[active];
      report.rankParity = { comparable: !!current && typeof rank?.current?.tier?.id === 'number',
        riotTier:current?.CompetitiveTier??null,henrikTier:rank?.current?.tier?.id??null,
        riotRR:current?.RankedRating??null,henrikRR:rank?.current?.rr??null,
        latestUpdateTier:raw.get('mmr')?.LatestCompetitiveUpdate?.TierAfterUpdate??null,
        latestHistoryTier:riotUpdates[0]?.TierAfterUpdate??null,
        seasonalFields:Object.keys(current||{}),mmrFields:Object.keys(raw.get('mmr')||{}),
        tierMatches: current && rank?.current?.tier?.id != null ? current.CompetitiveTier === rank.current.tier.id : null,
        rrMatches: current && rank?.current?.rr != null ? current.RankedRating === rank.current.rr : null };
      const matchId = shared.find(m => UUID.test(m.MatchID))?.MatchID;
      if (matchId && riotHeaders && !rateLimited) {
        let detail = raw.get('match-details');
        if (detail?.matchInfo?.matchId !== matchId) {
          try { const r = await measured(`https://pd.${player.region}.a.pvp.net/match-details/v1/matches/${matchId}`, { headers: riotHeaders });
            detail = r.ok ? await r.json() : null;
          } catch { detail = null; }
        }
        const hd = hm.find(h => h.metadata?.match_id === matchId);
        if (detail && hd) report.details = compareDetails(detail, hd);
      }
      if(deep&&riotHeaders&&!rateLimited) {
        report.fullPage={requested:Math.min(10,shared.length),returned:0,detailTransferMs:0,detailBytes:0,comparisons:[]};
        for(const match of shared.slice(0,10)) {
          if(rateLimited)break;
          try {
            const r=await measured(`https://pd.${player.region}.a.pvp.net/match-details/v1/matches/${match.MatchID}`,{headers:riotHeaders});
            if(!r.ok)break;
            const metric=metrics.at(-1);
            report.fullPage.returned++;report.fullPage.detailTransferMs+=metric.elapsedMs;report.fullPage.detailBytes+=metric.bytes;
            report.fullPage.comparisons.push(compareDetails(await r.json(),hm.find(h=>h.metadata?.match_id===match.MatchID)));
          }catch{report.notes.push('Full page details: request failed');break;}
        }
        for(const [label,path] of [['history-page2','match-history/v1/history'],['rr-page2','mmr/v1/players']]) {
          if(rateLimited)break;
          try {
            const tail=label==='rr-page2'?'/competitiveupdates':'';
            const r=await measured(`https://pd.${player.region}.a.pvp.net/${path}/${player.puuid}${tail}?startIndex=20&endIndex=40&queue=competitive`,{headers:riotHeaders});
            const data=r.ok?await r.json():null;
            report[label]={status:r.status,returned:(data?.History||data?.Matches||[]).length,total:data?.Total??null};
          }catch{report.notes.push(`${label}: request failed`);}
        }
      }
      if (riotHeaders && !rateLimited) {
        try {
          const r = await measured(`https://pd.${player.region}.a.pvp.net/match-history/v1/history/${player.puuid}?startIndex=100&endIndex=120&queue=competitive`, { headers: riotHeaders });
          report.olderHistory = { status: r.status, returned: r.ok ? (await r.json()).History?.length ?? 0 : 0 };
        } catch { report.notes.push('Older history: request failed'); }
      }
    } else report.notes.push('Henrik account lookup unavailable or identity mismatch');
  }
  report.elapsedMs = Date.now() - started;
  report.rateLimited = rateLimited;
  if (!direct.ok) report.notes.push(direct.error);
  if (direct.note) report.notes.push(direct.note);
  return report;
}
