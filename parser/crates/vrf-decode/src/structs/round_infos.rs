//! `OwnerExclusivePlayerInfo.RoundInfos` -- per-player per-round credit.

use vrf_bitio::BitReader;

use super::Result;
use super::framing::{decode_elements, member_name};

/// Names this blob in error messages.
const CONTEXT: &str = "RoundInfos";

/// A single player round-info entry (per-round economy for one player); a
/// `None` member was not sent in this update.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PlayerRoundInfo {
    /// Zero-based index within the array (round index within this update).
    pub index: u32,
    /// Round number.
    pub round_number: Option<i32>,
    /// Money at the start of the round.
    pub start_of_round_money: Option<i32>,
    /// Loadout value at the start of the round.
    pub start_of_round_loadout_value: Option<i32>,
    /// Money at the end of the round (the analytically critical field).
    pub end_of_round_money: Option<i32>,
    /// Loadout value at the end of the round.
    pub end_of_round_loadout_value: Option<i32>,
}

/// Decode an `OwnerExclusivePlayerInfo.RoundInfos` blob (arguments in the
/// module docs).
pub fn decode_round_infos(
    reader: &mut BitReader<'_>,
    declared: &[Option<&str>],
) -> Result<Vec<PlayerRoundInfo>> {
    decode_elements(
        reader,
        CONTEXT,
        |handle| member_name(declared, handle, CONTEXT),
        |index| PlayerRoundInfo {
            index,
            ..PlayerRoundInfo::default()
        },
        |row, name, sub| {
            let slot = match name {
                "RoundNumber" => &mut row.round_number,
                "StartOfRoundMoney" => &mut row.start_of_round_money,
                "StartOfRoundLoadoutValue" => &mut row.start_of_round_loadout_value,
                "EndOfRoundMoney" => &mut row.end_of_round_money,
                "EndOfRoundLoadoutValue" => &mut row.end_of_round_loadout_value,
                _ => return Ok(None),
            };
            // A fixed 32-bit Int32: a wider window is not this type and fails.
            *slot = Some(sub.read_i32()?);
            Ok(Some(name))
        },
    )
}
