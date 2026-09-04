// Only call with a fresh, server-fetched account response. Client-submitted
// names and names embedded in old matches must never become observations.
export async function observeName(db, account, observedAt) {
  const { puuid, name, tag } = account;
  if (![puuid, name, tag].every(v => typeof v === 'string' && v.length > 0) ||
      !Number.isFinite(Date.parse(observedAt))) throw new Error('Invalid account observation');
  const stamp = new Date(observedAt).toISOString();
  // D1 batches are atomic. Close the previous period, insert a new one only
  // if needed, then advance last_seen. A delayed older response cannot
  // roll a newer identity back; A -> B -> A remains three separate periods.
  await db.batch([
    db.prepare(`UPDATE player_name_history SET ended_at=?4
      WHERE puuid=?1 AND ended_at IS NULL AND (name<>?2 OR tag<>?3) AND last_seen<?4`)
      .bind(puuid, name, tag, stamp),
    db.prepare(`INSERT INTO player_name_history (puuid,name,tag,first_seen,last_seen)
      SELECT ?1,?2,?3,?4,?4 WHERE NOT EXISTS
        (SELECT 1 FROM player_name_history WHERE puuid=?1 AND (ended_at IS NULL OR last_seen>=?4))`)
      .bind(puuid, name, tag, stamp),
    db.prepare(`UPDATE player_name_history SET last_seen=MAX(last_seen,?4)
      WHERE puuid=?1 AND name=?2 AND tag=?3 AND ended_at IS NULL`)
      .bind(puuid, name, tag, stamp),
    // Enrol even players with no ranked games. A later RR fetch fills platform.
    db.prepare(`INSERT INTO rr_players (puuid,region,platform,name,tag,updated_at)
      VALUES (?1,?2,NULL,?3,?4,?5) ON CONFLICT(puuid) DO UPDATE SET
      region=COALESCE(excluded.region,rr_players.region),name=excluded.name,
      tag=excluded.tag,updated_at=excluded.updated_at
      WHERE rr_players.updated_at IS NULL OR rr_players.updated_at<excluded.updated_at`)
      .bind(puuid, account.region || null, name, tag, stamp),
  ]);
  return readNameHistory(db, puuid);
}

export async function readNameHistory(db, puuid) {
  const { results } = await db.prepare(`SELECT name,tag,first_seen,last_seen,ended_at
    FROM player_name_history WHERE puuid=?1 ORDER BY first_seen DESC,id DESC`).bind(puuid).all();
  return results || [];
}
