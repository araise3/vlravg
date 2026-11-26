//! `export --compact`: the site's compact replay document, version 1, built
//! in the same pass as the export (vlravg fork). It replaces
//! `scripts/replay-compact.py`, which read the export back through DuckDB, and
//! keeps its output: the format is `docs/replay-import.md#compact-format-version-1`,
//! and `tests/replay-parser-compact.test.mjs` compares the two.
//!
//! Every value comes from the replay itself; the submit job and the Function
//! validate the document as untrusted data.

use std::collections::{BTreeMap, HashMap};
use std::fmt::Write as _;

use vrf_container::Preamble;
use vrf_export::MovementRecord;

use crate::error::CliError;
use crate::sink::PlayerIdentity;

const INTERVAL_MS: u32 = 250;

/// What the caller states about the source and decoder; the document repeats it.
#[derive(Debug, Clone)]
pub struct CompactMeta {
    pub out: String,
    pub match_id: String,
    pub source_bytes: u64,
    pub source_sha256: String,
    pub decoder_revision: String,
    pub decoder_patch: Option<String>,
    /// (source, registry line) of the transform the replay was decoded with.
    pub transform: Option<(String, String)>,
}

/// One kept movement sample: its order key and rounded values.
#[derive(Debug, Clone, Copy)]
struct Sample {
    key: (u32, u32),
    values: [i64; 4],
}

/// One event row: (time1, id, group, word0, word1).
type EventRow = (u32, String, String, Option<u32>, Option<u32>);

/// Rows gathered during the pass.
#[derive(Debug, Default)]
pub struct CompactCollector {
    events: Vec<EventRow>,
    /// (guid, tick) -> last sample by (time_ms, packet_id).
    movement: HashMap<(u32, u32), Sample>,
}

impl CompactCollector {
    pub fn event(&mut self, time1: u32, id: &str, group: &str, word0: Option<u32>, word1: Option<u32>) {
        self.events.push((time1, id.to_owned(), group.to_owned(), word0, word1));
    }

    /// Movement rows of one packet, before the table writer takes them.
    pub fn movement(&mut self, rows: &[MovementRecord]) {
        for r in rows {
            if !(r.pos_x.is_finite() && r.pos_y.is_finite() && r.pos_z.is_finite() && r.yaw.is_finite()) {
                continue;
            }
            let key = (r.time_ms, r.packet_id);
            let sample = Sample {
                key,
                // Half away from zero, as SQL `round`; yaw keeps fmod's sign.
                values: [
                    r.pos_x.round() as i64,
                    r.pos_y.round() as i64,
                    r.pos_z.round() as i64,
                    (r.yaw.round() % 360.0) as i64,
                ],
            };
            let slot = self
                .movement
                .entry((r.character_net_guid, r.time_ms / INTERVAL_MS))
                .or_insert(sample);
            if key >= slot.key {
                *slot = sample;
            }
        }
    }
}

fn uuid_or_none(value: &str) -> Option<String> {
    let v = value.trim().to_ascii_lowercase();
    let b = v.as_bytes();
    let ok = b.len() == 36
        && b.iter().enumerate().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => *c == b'-',
            _ => c.is_ascii_digit() || (b'a'..=b'f').contains(c),
        });
    ok.then_some(v)
}

/// Agent UUID per subject, from `game_specific_data`'s `playerLoadouts`.
fn loadouts(game_specific_data: &[String]) -> HashMap<String, Option<String>> {
    let mut agents = HashMap::new();
    for blob in game_specific_data {
        let Ok(serde_json::Value::Object(data)) = serde_json::from_str::<serde_json::Value>(blob) else {
            continue;
        };
        let Some(serde_json::Value::Array(rows)) = data.get("playerLoadouts") else { continue };
        for row in rows {
            let field = |k: &str| row.get(k).and_then(serde_json::Value::as_str).and_then(uuid_or_none);
            if let Some(subject) = field("subject") {
                agents.insert(subject, field("characterId"));
            }
        }
    }
    agents
}

fn json_str(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 || (c as u32) > 0x7f => {
                // ASCII-only output, as Python's json.dumps: surrogate pairs above the BMP.
                let mut units = [0u16; 2];
                for u in c.encode_utf16(&mut units) {
                    let _ = write!(out, "\\u{u:04x}");
                }
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

fn truncate_chars(s: &str, n: usize) -> &str {
    s.char_indices().nth(n).map_or(s, |(i, _)| &s[..i])
}

fn list<T>(out: &mut String, items: impl IntoIterator<Item = T>, mut each: impl FnMut(&mut String, T)) {
    out.push('[');
    for (i, item) in items.into_iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        each(out, item);
    }
    out.push(']');
}

/// Counters the document's `quality` repeats from the manifest.
#[derive(Debug, Clone, Copy, Default)]
pub struct CompactQuality {
    pub content_blocks_lost: u64,
    pub movement_rows: u64,
    pub event_rows: u64,
    pub malformed_packets: u64,
    pub transform_failures: u64,
}

/// The replay header facts the document repeats.
#[derive(Debug, Clone)]
pub struct ReplayFacts<'a> {
    pub friendly_name: &'a str,
    pub branch: &'a str,
    pub map_path: &'a str,
    pub game_specific_data: &'a [String],
    pub duration_ms: i64,
    pub recorded_ticks: i64,
}

impl<'a> ReplayFacts<'a> {
    pub fn from_preamble(preamble: &'a Preamble) -> Self {
        let header = &preamble.header;
        Self {
            friendly_name: &preamble.info.friendly_name,
            branch: &header.replay_version.branch,
            map_path: header.level_names_and_times.first().map_or("", |(name, _)| name.as_str()),
            game_specific_data: &header.game_specific_data,
            duration_ms: i64::from(preamble.info.length_in_ms),
            recorded_ticks: preamble.info.timestamp,
        }
    }
}

/// Build the document. `players` is the manifest's list: subject set, sorted by actor GUID.
pub fn build(
    meta: &CompactMeta,
    collector: CompactCollector,
    facts: &ReplayFacts<'_>,
    players: &[(u32, &PlayerIdentity)],
    quality: &CompactQuality,
) -> Result<String, CliError> {
    let embedded = uuid_or_none(facts.friendly_name);
    if embedded.as_deref() != Some(meta.match_id.as_str()) {
        return Err(CliError::Usage(format!(
            "replay match ID {} does not match {}",
            embedded.as_deref().unwrap_or("None"),
            meta.match_id
        )));
    }
    let agents = loadouts(facts.game_specific_data);

    let mut subjects: Vec<(String, Option<String>)> = Vec::new();
    let mut by_guid: BTreeMap<u32, usize> = BTreeMap::new();
    for (_, id) in players {
        let Some(subject) = id.subject.as_deref().and_then(uuid_or_none) else { continue };
        if subjects.iter().any(|(s, _)| *s == subject) {
            continue;
        }
        let index = subjects.len();
        let agent = agents.get(&subject).cloned().flatten();
        subjects.push((subject, agent));
        // `character_net_guids`, else the current body: the same list.
        for &guid in &id.character_net_guids {
            if guid > 0 {
                by_guid.insert(guid, index);
            }
        }
    }
    let who = |guid: Option<u32>| guid.and_then(|g| by_guid.get(&g)).map_or(-1, |&i| i as i64);

    let mut events = collector.events;
    events.sort_by(|a, b| (a.0, &a.1).cmp(&(b.0, &b.1)));
    let mut rounds = Vec::new();
    let mut kills = Vec::new();
    let mut ultimates = Vec::new();
    let (mut plants, mut defuses, mut detonations, mut switches) = (vec![], vec![], vec![], vec![]);
    for (t, _, group, w0, w1) in &events {
        match group.as_str() {
            "roundStarted" => rounds.push((*t, w0.map_or(-1, i64::from))),
            "characterDeath" => kills.push((*t, who(*w0), who(*w1))),
            "characterUltimateUsed" => ultimates.push((*t, who(*w0))),
            "spikePlanted" => plants.push(*t),
            "spikeDefused" => defuses.push(*t),
            "spikeExploded" => detonations.push(*t),
            "switchTeams" => switches.push(*t),
            _ => {}
        }
    }

    // Per player: guids in order, ticks in order; a later guid's tick replaces.
    let mut per_player: BTreeMap<usize, BTreeMap<u32, [i64; 4]>> = BTreeMap::new();
    let mut rows: Vec<((u32, u32), Sample)> = collector.movement.into_iter().collect();
    rows.sort_unstable_by_key(|(k, _)| *k);
    for ((guid, tick), sample) in rows {
        if let Some(&index) = by_guid.get(&guid) {
            per_player.entry(index).or_default().insert(tick, sample.values);
        }
    }

    let mut o = String::with_capacity(1 << 20);
    o.push_str("{\"format\":\"vlravg.replay-compact\",\"version\":1,\"match_id\":");
    json_str(&mut o, &meta.match_id);
    let _ = write!(o, ",\"source\":{{\"bytes\":{},\"sha256\":", meta.source_bytes);
    json_str(&mut o, &meta.source_sha256);
    o.push_str("},\"decoder\":{\"name\":\"vrfkit\",\"revision\":");
    json_str(&mut o, &meta.decoder_revision);
    o.push_str(",\"patch\":");
    match &meta.decoder_patch {
        Some(p) => json_str(&mut o, p),
        None => o.push_str("null"),
    }
    if let Some((source, line)) = &meta.transform {
        o.push_str(",\"transform\":{\"source\":");
        json_str(&mut o, source);
        o.push_str(",\"line\":");
        json_str(&mut o, line);
        o.push('}');
    }
    o.push_str("},\"replay\":{\"build\":");
    json_str(&mut o, truncate_chars(facts.branch, 64));
    o.push_str(",\"map_path\":");
    json_str(&mut o, truncate_chars(facts.map_path, 128));
    let _ = write!(
        o,
        ",\"duration_ms\":{},\"recorded_ticks\":\"{}\"}}",
        facts.duration_ms, facts.recorded_ticks
    );
    let q = quality;
    let _ = write!(
        o,
        ",\"quality\":{{\"content_blocks_lost\":{},\"movement_rows\":{},\"event_rows\":{},\"malformed_packets\":{},\"transform_failures\":{}}}",
        q.content_blocks_lost, q.movement_rows, q.event_rows, q.malformed_packets, q.transform_failures
    );
    o.push_str(",\"players\":");
    list(&mut o, &subjects, |o, (subject, agent)| {
        o.push_str("{\"subject\":");
        json_str(o, subject);
        o.push_str(",\"character_id\":");
        match agent {
            Some(a) => json_str(o, a),
            None => o.push_str("null"),
        }
        o.push('}');
    });
    o.push_str(",\"events\":{\"rounds\":");
    list(&mut o, &rounds, |o, (t, r)| {
        let _ = write!(o, "[{t},{r}]");
    });
    o.push_str(",\"kills\":");
    list(&mut o, &kills, |o, (t, k, d)| {
        let _ = write!(o, "[{t},{k},{d}]");
    });
    for (name, times) in [("plants", &plants), ("defuses", &defuses), ("detonations", &detonations)] {
        let _ = write!(o, ",\"{name}\":");
        list(&mut o, times.iter(), |o, t| {
            let _ = write!(o, "{t}");
        });
    }
    o.push_str(",\"ultimates\":");
    list(&mut o, &ultimates, |o, (t, p)| {
        let _ = write!(o, "[{t},{p}]");
    });
    o.push_str(",\"switch_teams\":");
    list(&mut o, &switches, |o, t| {
        let _ = write!(o, "{t}");
    });
    o.push_str("},\"movement\":{\"interval_ms\":250,\"encoding\":\"delta-v1\",\"tracks\":");
    list(&mut o, &per_player, |o, (index, samples)| {
        let _ = write!(o, "{{\"player\":{index},\"samples\":");
        let mut previous = [0i64; 5];
        list(o, samples.iter().flat_map(|(tick, v)| {
            let row = [i64::from(*tick), v[0], v[1], v[2], v[3]];
            let delta: Vec<i64> = row.iter().zip(previous).map(|(a, b)| a - b).collect();
            previous = row;
            delta
        }), |o, d| {
            let _ = write!(o, "{d}");
        });
        o.push('}');
    });
    o.push_str("}}");
    Ok(o)
}


#[cfg(test)]
mod tests {
    //! The cases `tests/replay_compact_test.py` held for the Python reducer.
    use super::*;

    const MATCH: &str = "a27d4487-c781-4b73-8a9e-f4a468139bba";
    const A: &str = "00000000-0000-4000-8000-000000000001";
    const B: &str = "00000000-0000-4000-8000-000000000002";
    const AGENT: &str = "22697a3d-45bf-8dd7-4fec-84a9e28c69d7";

    fn meta() -> CompactMeta {
        CompactMeta {
            out: String::new(),
            match_id: MATCH.into(),
            source_bytes: 64,
            source_sha256: "0".repeat(64),
            decoder_revision: "b9496df61c40fa304d4f539689c1dd627804946e".into(),
            decoder_patch: None,
            transform: Some(("compiled".into(), "0x3c17_a9fa -0x06: add 8".into())),
        }
    }

    fn movement(time_ms: u32, packet_id: u32, guid: u32, x: f32, y: f32, z: f32, yaw: f32) -> MovementRecord {
        MovementRecord {
            time_ms,
            packet_id,
            character_net_guid: guid,
            pos_x: x,
            pos_y: y,
            pos_z: z,
            yaw,
            pitch: 0.0,
            vel_x: 0.0,
            vel_y: 0.0,
            vel_z: 0.0,
            timestamp: 0,
            movement_state: 0,
            move_type: 0,
        }
    }

    fn build_doc(friendly: &str) -> Result<serde_json::Value, CliError> {
        let gsd = vec![
            r#"{"serializedVersion": 2}"#.to_owned(),
            format!(r#"{{"playerLoadouts": [{{"subject": "{A}", "characterId": "{AGENT}"}}, {{"subject": "{B}", "characterId": "x"}}]}}"#),
        ];
        let facts = ReplayFacts {
            friendly_name: friendly,
            branch: "++Ares-Core+release-13.08",
            map_path: "/Game/Maps/Duality/Duality",
            game_specific_data: &gsd,
            duration_ms: 60000,
            recorded_ticks: 639_275_987_627_950_000,
        };
        let a = PlayerIdentity { subject: Some(A.to_uppercase()), character_net_guids: vec![10, 20] };
        let b = PlayerIdentity { subject: Some(B.into()), character_net_guids: vec![30] };
        let mut c = CompactCollector::default();
        c.event(100, "e1", "roundStarted", Some(0), None);
        c.event(6000, "e3", "characterDeath", Some(99), Some(20));
        c.event(5000, "e2", "characterDeath", Some(30), Some(10));
        c.event(7000, "e4", "characterUltimateUsed", Some(30), None);
        c.event(8000, "e5", "spikePlanted", None, None);
        c.movement(&[
            movement(100, 1, 10, 100.4, 200.0, 10.0, 90.2),
            movement(200, 2, 10, 101.0, 200.0, 10.0, 91.0),
            movement(300, 3, 20, 150.0, 210.0, 10.0, 359.7),
            movement(300, 4, 30, -5.0, -6.0, 0.0, 0.0),
            movement(900, 5, 30, f32::INFINITY, 0.0, 0.0, 0.0),
            movement(100, 6, 77, 1.0, 1.0, 1.0, 1.0),
        ]);
        let doc = build(&meta(), c, &facts, &[(1, &a), (2, &b)], &CompactQuality::default())?;
        Ok(serde_json::from_str(&doc).expect("valid JSON"))
    }

    #[test]
    fn players_events_and_identity() {
        let doc = build_doc(MATCH).unwrap();
        assert_eq!(
            doc["players"],
            serde_json::json!([{"subject": A, "character_id": AGENT}, {"subject": B, "character_id": null}])
        );
        // (killer, killed): B killed A's first pawn; an unknown killer stays -1. Sorted by time.
        assert_eq!(doc["events"]["kills"], serde_json::json!([[5000, 1, 0], [6000, -1, 0]]));
        assert_eq!(doc["events"]["ultimates"], serde_json::json!([[7000, 1]]));
        assert_eq!(doc["events"]["rounds"], serde_json::json!([[100, 0]]));
        assert_eq!(doc["events"]["plants"], serde_json::json!([8000]));
        assert_eq!(doc["replay"]["map_path"], "/Game/Maps/Duality/Duality");
        assert_eq!(doc["replay"]["recorded_ticks"], "639275987627950000");
        assert_eq!(doc["decoder"]["transform"], serde_json::json!({"source": "compiled", "line": "0x3c17_a9fa -0x06: add 8"}));
    }

    #[test]
    fn movement_is_bucketed_rounded_and_delta_encoded() {
        let doc = build_doc(MATCH).unwrap();
        let tracks = doc["movement"]["tracks"].as_array().unwrap();
        // Player 0: buckets 0 (t=200 wins over t=100) and 1 (second pawn).
        // Yaw 359.7 rounds to 360 and wraps to 0. Non-finite rows are dropped.
        assert_eq!(tracks[0]["samples"], serde_json::json!([0, 101, 200, 10, 91, 1, 49, 10, 0, -91]));
        assert_eq!(tracks[1]["samples"], serde_json::json!([1, -5, -6, 0, 0]));
    }

    #[test]
    fn a_tie_keeps_the_later_row_in_stream_order() {
        let mut c = CompactCollector::default();
        c.movement(&[movement(100, 1, 10, 1.0, 0.0, 0.0, 0.0), movement(100, 1, 10, 2.0, 0.0, 0.0, 0.0)]);
        assert_eq!(c.movement[&(10, 0)].values[0], 2);
    }

    #[test]
    fn rounding_is_half_away_from_zero() {
        let mut c = CompactCollector::default();
        c.movement(&[movement(0, 1, 10, 0.5, -0.5, 2.5, -10.4)]);
        assert_eq!(c.movement[&(10, 0)].values, [1, -1, 3, -10]);
    }

    #[test]
    fn wrong_embedded_match_is_refused() {
        assert!(build_doc("bd2ea657-0865-4cd7-934c-f6478cd43a64").is_err());
    }

    #[test]
    fn strings_are_ascii_json() {
        let mut s = String::new();
        json_str(&mut s, "a\"\\\u{1}é\u{7f}");
        assert_eq!(s, "\"a\\\"\\\\\\u0001\\u00e9\u{7f}\"");
    }
}
