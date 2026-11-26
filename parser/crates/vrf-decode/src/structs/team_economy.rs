//! `BombGameState.TeamEconomy` -- team loadout value per round.

use vrf_bitio::BitReader;

use super::framing::{decode_elements, member_name};
use super::{Result, StructBlobError};

/// Names this blob in error messages.
const CONTEXT: &str = "TeamEconomy";

/// A single team economy update.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TeamEconomyUpdate {
    /// Zero-based team index (0 = first team, 1 = second team).
    pub index: u32,
    /// The actor replication ID for this team (only present on initial spawn).
    pub replication_id: Option<u32>,
    /// Total loadout value for the team this round.
    pub loadout_value: Option<i32>,
    /// Average loadout value per player for the team this round.
    pub average_loadout_value: Option<i32>,
}

/// Decode a `BombGameState.TeamEconomy` blob under the fixed 12.06-13.01
/// handles: 56 ReplicationId (IntPacked), 57 LoadoutValue and 58
/// AverageLoadoutValue (Int32). Replay parsers should use
/// [`decode_team_economy_declared`], which also reads the older 53..=55 layout.
pub fn decode_team_economy(reader: &mut BitReader<'_>) -> Result<Vec<TeamEconomyUpdate>> {
    decode_members(reader, |handle| match handle {
        56 => Ok("241"),
        57 => Ok("LoadoutValue"),
        58 => Ok("AverageLoadoutValue"),
        _ => Err(StructBlobError::UnsupportedHandle {
            handle,
            context: CONTEXT,
        }),
    })
}

/// Decode TeamEconomy under the enclosing group's declarations. The
/// replication ID is declared as hardcoded FName index `241` (read as
/// IntPacked); unknown or missing declarations are errors, never a fallback.
pub fn decode_team_economy_declared(
    reader: &mut BitReader<'_>,
    declared: &[Option<&str>],
) -> Result<Vec<TeamEconomyUpdate>> {
    decode_members(reader, |handle| member_name(declared, handle, CONTEXT))
}

fn decode_members<'a>(
    reader: &mut BitReader<'_>,
    name_for: impl FnMut(u32) -> Result<&'a str>,
) -> Result<Vec<TeamEconomyUpdate>> {
    decode_elements(
        reader,
        CONTEXT,
        name_for,
        |index| TeamEconomyUpdate {
            index,
            ..TeamEconomyUpdate::default()
        },
        // Each member owes its whole window; the IntPacked one, declared as
        // `241`, is reported as `ReplicationId`.
        |row, name, sub| {
            Ok(Some(match name {
                "241" => {
                    row.replication_id = Some(sub.read_int_packed()?);
                    "ReplicationId"
                }
                "LoadoutValue" => {
                    row.loadout_value = Some(sub.read_i32()?);
                    "LoadoutValue"
                }
                "AverageLoadoutValue" => {
                    row.average_loadout_value = Some(sub.read_i32()?);
                    "AverageLoadoutValue"
                }
                _ => return Ok(None),
            }))
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    // 12.01 sample-1, first TeamEconomy update. No player identifiers.
    const INITIAL: [u8; 36] = [
        4, 2, 108, 16, 124, 110, 64, 0, 0, 0, 0, 112, 64, 0, 0, 0, 0, 0, 4, 108, 16, 128, 110, 64,
        0, 0, 0, 0, 112, 64, 0, 0, 0, 0, 0, 0,
    ];

    #[test]
    fn legacy_economy_uses_declared_handles_and_preserves_values() {
        let mut names = [None; 59];
        names[53] = Some("241");
        names[54] = Some("LoadoutValue");
        names[55] = Some("AverageLoadoutValue");
        let rows = decode_team_economy_declared(&mut BitReader::new(&INITIAL), &names).unwrap();
        assert_eq!(
            rows,
            vec![
                TeamEconomyUpdate {
                    index: 0,
                    replication_id: Some(62),
                    loadout_value: Some(0),
                    average_loadout_value: Some(0)
                },
                TeamEconomyUpdate {
                    index: 1,
                    replication_id: Some(64),
                    loadout_value: Some(0),
                    average_loadout_value: Some(0)
                },
            ]
        );
        // Next captured update: independently read little-endian Int32 values.
        let update = [
            4, 2, 110, 64, 48, 17, 0, 0, 112, 64, 112, 3, 0, 0, 0, 4, 110, 64, 248, 17, 0, 0, 112,
            64, 152, 3, 0, 0, 0, 0,
        ];
        let rows = decode_team_economy_declared(&mut BitReader::new(&update), &names).unwrap();
        assert_eq!(rows[0].replication_id, None);
        assert_eq!(rows[0].loadout_value, Some(4400));
        assert_eq!(rows[0].average_loadout_value, Some(880));
        assert_eq!(rows[1].loadout_value, Some(4600));
        assert_eq!(rows[1].average_loadout_value, Some(920));
        // Renaming a declared member must fail rather than use its old handle.
        names[54] = Some("UnrecognizedMember");
        assert!(matches!(
            decode_team_economy_declared(&mut BitReader::new(&INITIAL), &names),
            Err(StructBlobError::UnsupportedMember { handle: 54, .. })
        ));
        assert!(matches!(
            decode_team_economy_declared(&mut BitReader::new(&INITIAL), &[]),
            Err(StructBlobError::UndeclaredHandle { handle: 53, .. })
        ));
    }
}
