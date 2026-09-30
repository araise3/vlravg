// Server-observed evidence for durable archive coverage. Browsers select a
// scan ID, but cannot supply match rows, page evidence, or completeness flags.
const scopeArgs=s=>[s.puuid,s.season_id,s.region,s.platform];
const ids=text=>{
  const value=JSON.parse(text);
  if(!Array.isArray(value)||value.some(id=>typeof id!=='string'||!id))throw new Error('Invalid coverage');
  return [...new Set(value)];
};

async function allArchived(db,scope,matchIds){
  const row=await db.prepare(
    'SELECT COUNT(*) AS n FROM match_archive WHERE puuid=?1 AND season_id=?2 '
    + 'AND length(payload)>0 AND match_id IN (SELECT value FROM json_each(?3))'
  ).bind(scope.puuid,scope.season_id,JSON.stringify(matchIds)).first();
  return row?.n===matchIds.length;
}

export async function beginCoverageScan(db,scope){
  const saved=await db.prepare('SELECT match_ids,live_ids FROM match_archive_coverage '
    + 'WHERE puuid=?1 AND season_id=?2 AND region=?3 AND platform=?4').bind(...scopeArgs(scope)).first();
  let matchIds=[],liveIds=[];
  if(saved){
    matchIds=ids(saved.match_ids);liveIds=ids(saved.live_ids);
    if(!await allArchived(db,scope,matchIds)){
      await db.prepare('DELETE FROM match_archive_coverage WHERE puuid=?1 AND season_id=?2 '
        + 'AND region=?3 AND platform=?4 AND match_ids=?5').bind(...scopeArgs(scope),saved.match_ids).run();
      matchIds=[];liveIds=[];
    }
  }
  const scanId=crypto.randomUUID();
  // Only abandoned verification ledgers are pruned; durable coverage itself
  // never ages out. A returning visitor gets a new independent ledger.
  const cutoff=new Date(Date.now()-86400000).toISOString();
  await db.batch([
    db.prepare('DELETE FROM match_archive_scan_pages WHERE scan_id IN '
      + '(SELECT scan_id FROM match_archive_scans WHERE created_at<?1)').bind(cutoff),
    db.prepare('DELETE FROM match_archive_scans WHERE created_at<?1').bind(cutoff),
    db.prepare('INSERT INTO match_archive_scans '
      + '(scan_id,puuid,season_id,region,platform,base_match_ids,base_live_ids,created_at) '
      + 'VALUES (?1,?2,?3,?4,?5,?6,?7,?8)').bind(scanId,...scopeArgs(scope),
      JSON.stringify(matchIds),JSON.stringify(liveIds),new Date().toISOString()),
  ]);
  return{scanId,coverage:saved&&matchIds.length?{matchIds,liveIds}:null};
}

export async function readCoverageScan(db,scanId){
  return db.prepare('SELECT * FROM match_archive_scans WHERE scan_id=?1').bind(scanId).first();
}

export async function recordCoveragePage(db,scan,kind,start,payload){
  if(!Array.isArray(payload?.data))return;
  const rows=payload.data.map(row=>kind==='live'?{
    id:row?.metadata?.match_id,
    season:(row?.metadata?.season?.id||row?.metadata?.season_id||'').toLowerCase(),
    at:Date.parse(row?.metadata?.started_at),
    owner:row?.players?.some(p=>p.puuid?.toLowerCase()===scan.puuid),
  }:{
    id:row?.meta?.id,season:(row?.meta?.season?.id||'').toLowerCase(),
    at:Date.parse(row?.meta?.started_at),owner:row?.stats?.puuid?.toLowerCase()===scan.puuid,
  });
  if(rows.some(row=>typeof row.id!=='string'||!row.id||row.id.length>128||!row.season||!Number.isFinite(row.at)||!row.owner))return;
  const data={rows:rows.map(({owner,...row})=>row),after:payload.results?.after??null};
  await db.prepare('INSERT INTO match_archive_scan_pages (scan_id,kind,page_start,data) VALUES (?1,?2,?3,?4) '
    + 'ON CONFLICT(scan_id,kind,page_start) DO UPDATE SET data=excluded.data')
    .bind(scan.scan_id,kind,start,JSON.stringify(data)).run();
}

function verifyPages(pages,kind,season,baseLiveIds){
  if(!pages.length)return null;
  const selected=new Set(),seen=new Set(),base=new Set(baseLiveIds);
  let expected=kind==='stored'?1:pages[0].page_start;
  let previousAt=Infinity,seenTarget=false,knownStreak=0;
  // A calendar-ordered old-act scan can begin at a newer-act overlap page.
  // Starting halfway through the selected act cannot prove full coverage.
  let startsBefore=kind==='stored'||expected===0;
  for(const page of pages){
    if(page.page_start!==expected)return null;
    const data=JSON.parse(page.data),rows=data.rows;
    if(!Array.isArray(rows)||rows.length>(kind==='live'?10:100))return null;
    if(!seenTarget&&rows[0]?.season!==season&&rows.length)startsBefore=true;
    for(const row of rows){
      if(!row.id||!row.season||!Number.isFinite(row.at)||row.at>previousAt||seen.has(row.id))return null;
      previousAt=row.at;seen.add(row.id);
      if(row.season===season){seenTarget=true;selected.add(row.id);}
    }
    const olderBoundary=seenTarget&&rows.length&&rows.every(row=>row.season!==season);
    knownStreak=kind==='live'&&rows.length&&rows.every(row=>base.has(row.id))?knownStreak+1:0;
    if(kind==='live'&&knownStreak>=2)return{selected,incremental:true};
    if(!rows.length||(kind==='stored'&&data.after===0)||olderBoundary){
      return startsBefore&&(kind==='stored'||pages[0].page_start===0||seenTarget)?{selected,incremental:false}:null;
    }
    expected+=kind==='stored'?1:rows.length;
  }
  return null;
}

export async function finishCoverageScan(db,scope,scanId){
  const scan=await readCoverageScan(db,scanId);
  if(!scan||scopeArgs(scope).some((value,i)=>value!==scopeArgs(scan)[i]))return{verified:false};
  const {results}=await db.prepare('SELECT kind,page_start,data FROM match_archive_scan_pages '
    + 'WHERE scan_id=?1 ORDER BY kind,page_start').bind(scanId).all();
  const baseMatches=ids(scan.base_match_ids),baseLive=ids(scan.base_live_ids);
  const live=verifyPages((results||[]).filter(p=>p.kind==='live'),'live',scan.season_id,baseLive);
  const stored=verifyPages((results||[]).filter(p=>p.kind==='stored'),'stored',scan.season_id,[]);
  if(!live||!stored)return{verified:false};
  if(live.incremental&&(!baseMatches.length||!await allArchived(db,scan,baseMatches)))return{verified:false};
  const required=[...new Set([...baseMatches,...live.selected,...stored.selected])];
  if(!await allArchived(db,scan,required))return{verified:false};
  const liveIds=[...new Set([...baseLive,...live.selected])];
  // Monotonic union protects simultaneous valid scans: a slower visitor must
  // not erase IDs that another visitor already verified and saved.
  await db.batch([
    db.prepare('INSERT INTO match_archive_coverage '
      + '(puuid,season_id,region,platform,match_ids,live_ids,verified_at) VALUES (?1,?2,?3,?4,?5,?6,?7) '
      + 'ON CONFLICT(puuid,season_id,region,platform) DO UPDATE SET '
      + 'match_ids=(SELECT json_group_array(value) FROM (SELECT value FROM json_each(match_archive_coverage.match_ids) '
      + 'UNION SELECT value FROM json_each(excluded.match_ids))), '
      + 'live_ids=(SELECT json_group_array(value) FROM (SELECT value FROM json_each(match_archive_coverage.live_ids) '
      + 'UNION SELECT value FROM json_each(excluded.live_ids))),verified_at=excluded.verified_at')
      .bind(...scopeArgs(scan),JSON.stringify(required),JSON.stringify(liveIds),new Date().toISOString()),
    db.prepare('DELETE FROM match_archive_scan_pages WHERE scan_id=?1').bind(scanId),
    db.prepare('DELETE FROM match_archive_scans WHERE scan_id=?1').bind(scanId),
  ]);
  return{verified:true};
}
