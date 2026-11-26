//! Blueprint properties typed by exact group, name and checksum: entries of
//! `tools/fixtures/scoped_type_evidence.json` (generated into
//! `scoped_types.rs`) for classes no descriptor described, typed on
//! three independent legs -- the 13.06 class definition, the replay's
//! `compatible_checksum` (recomputed in
//! `tools/tests/test_compatible_checksum_facts.py`) and an independent reader of
//! every corpus row. The fixture carries the measurements; these tests pin a
//! real payload to that reader's value (`no_scoped_identity_is_shadowed_by_the_table`
//! holds every entry to its exact identity).

use super::overlay::{BOMB_GS, SWIFT_GS, apply_scoped};
use crate::decode::FieldType;
use crate::overlay::OverlayStats;

const REVEAL_BOLT: &str = "/Game/Characters/Hunter/S0/Ability_Q/\
Projectile_Hunter_Q_RevealBolt.Projectile_Hunter_Q_RevealBolt_C";
const SHOCK_BOLT: &str = "/Game/Characters/Hunter/S0/Ability_4/\
Projectile_Hunter_4_ExplosiveBolt.Projectile_Hunter_4_ExplosiveBolt_C";
const POSSESSABLE: &str = "/Game/Characters/States/PossessableActorComponent.\
PossessableActorComponent_C";
const CYPHER_CAMERA: &str = "/Game/Characters/Gumshoe/S0/Ability_E/\
Pawn_Gumshoe_E_PossessableCamera.Pawn_Gumshoe_E_PossessableCamera_C";
const KJ_TURRET: &str = "/Game/Characters/Killjoy/S0/Ability_E/\
Ability_Killjoy_E_Turret.Ability_Killjoy_E_Turret_C";
const KJ_ALARMBOT: &str = "/Game/Characters/Killjoy/S0/Ability_Q/\
Ability_Killjoy_Q_Alarmbot.Ability_Killjoy_Q_Alarmbot_C";
const CHARGED: &str = "/Game/Characters/Global/ChargedProjectileTargeting/\
Comp_Equippable_Charged.Comp_Equippable_Charged_C";

/// The four value columns, in `OverlayResult` order.
type Values = (Option<i64>, Option<f64>, Option<bool>, Option<String>);

/// (group, field, checksum, payload, bit count, the independent values).
type Case<'a> = (&'a str, &'a str, u32, &'a [u8], u32, Values);

const NO_VALUE: Values = (None, None, None, None);

fn int(value: i64) -> Values {
    (Some(value), None, None, None)
}

fn float(value: f64) -> Values {
    (None, Some(value), None, None)
}

fn bool_(value: bool) -> Values {
    (None, None, Some(value), None)
}

fn string(value: &str) -> Values {
    (None, None, None, Some(value.to_owned()))
}

/// One real payload through the whole overlay path, as its four value columns.
fn decode(
    stats: &mut OverlayStats,
    group: &str,
    field: &str,
    checksum: u32,
    raw: &[u8],
    bits: u32,
) -> Values {
    apply_scoped(stats, group, field, 15, checksum, raw, bits).into_columns()
}

/// Decode every case, requiring its values. Returns the stats for the
/// caller's count check.
fn decode_cases(cases: &[Case<'_>]) -> OverlayStats {
    let mut stats = OverlayStats::default();
    for (group, field, checksum, raw, bits, want) in cases {
        let got = decode(&mut stats, group, field, *checksum, raw, *bits);
        assert_eq!(got, *want, "{group} {field}");
    }
    stats
}

/// Real 13.06 payloads, and the values an independent reader
/// (`struct.unpack` / an IntPacked loop) gave them.
#[test]
fn two_d_blueprint_payloads_decode_to_the_independent_values() {
    // Sova's recon bolt: three little-endian doubles, a world position.
    let trail = [
        0x00, 0x00, 0x00, 0x60, 0x6c, 0xc8, 0xba, 0x40, 0x00, 0x00, 0x00, 0xe0, 0x07, 0x9c, 0xbe,
        0xc0, 0x00, 0x00, 0x00, 0xc0, 0x81, 0xc2, 0x7c, 0x40,
    ];
    let charge = [0x9a, 0x99, 0x99, 0x99, 0x99, 0x99, 0xb9, 0x3f];
    let stats = decode_cases(&[
        (
            REVEAL_BOLT,
            "TrailPosition",
            3_110_715_024,
            &trail,
            192,
            string("(6856.42333984375,-7836.03076171875,460.15667724609375)"),
        ),
        (
            POSSESSABLE,
            "IsPossessed",
            1_066_899_736,
            &[1],
            1,
            bool_(true),
        ),
        (
            CYPHER_CAMERA,
            "Possessed",
            2_181_339_745,
            &[0],
            1,
            bool_(false),
        ),
        // IntPacked: 0x7d continues with 62, 0x3a stops with 29 -> 62 + 29 * 128.
        (
            KJ_TURRET,
            "DeployedActor",
            2_740_089_937,
            &[0x7d, 0x3a],
            16,
            int(3_774),
        ),
        // The 8-bit null reference is GUID 0, a value, not a failure.
        (KJ_ALARMBOT, "DeployedActor", 2_740_089_937, &[0], 8, int(0)),
        (
            CHARGED,
            "CurrentCharge",
            1_908_355_023,
            &charge,
            64,
            float(0.1),
        ),
        (
            BOMB_GS,
            "CurrentLossStreak",
            1_863_385_026,
            &[1, 0, 0, 0],
            32,
            int(1),
        ),
        (
            SWIFT_GS,
            "LossStreakTeam",
            22_256_526,
            &[0x75, 0x06],
            16,
            int(58 + 3 * 128),
        ),
    ]);
    assert_eq!((stats.decoded_ok, stats.decoded_err), (8, 0));
}

/// A payload of another width is a counted decode error with no value: the
/// type is the full claim, and a 32-bit float or a 2-bit flag in these slots
/// would be a different property, not a shorter reading of this one.
#[test]
fn two_d_blueprint_fields_refuse_another_width() {
    let stats = decode_cases(&[
        (
            SHOCK_BOLT,
            "TrailPosition",
            3_110_715_024,
            &[0; 12],
            96,
            NO_VALUE,
        ),
        (POSSESSABLE, "IsPossessed", 1_066_899_736, &[1], 2, NO_VALUE),
        (
            CHARGED,
            "CurrentCharge",
            1_908_355_023,
            &[0; 4],
            32,
            NO_VALUE,
        ),
    ]);
    assert_eq!((stats.decoded_ok, stats.decoded_err), (0, 3));
}

/// `OverrideMatchTimerText` is an `FText` (its checksum reproduces with
/// `FText`), and what it sends is two histories: the 72-bit empty form while
/// the timer is not overridden and a 376-bit history 4 (`AsNumber`) while it
/// is. `FText` keeps only string-table keys and refuses both, so the identity
/// is typed `FTextTree`, the full-tree reader.
#[test]
fn match_timer_text_decodes_both_observed_histories() {
    const CHECKSUM: u32 = 4_004_484_071;
    let empty = [0, 0, 0, 0, 0xff, 0, 0, 0, 0];
    let number = [
        0x01, 0x00, 0x00, 0x00, 0x04, 0x03, 0x00, 0x00, 0x00, 0x80, 0x5f, 0x3a, 0x2f, 0x40, 0x01,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00,
        0x00, 0x02, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00,
    ];
    let mut cases = Vec::new();
    for group in [BOMB_GS, SWIFT_GS] {
        cases.push((
            group,
            "OverrideMatchTimerText",
            CHECKSUM,
            &empty[..],
            72,
            string(r#"{"flags":0,"history":255,"kind":"empty"}"#),
        ));
        cases.push((
            group,
            "OverrideMatchTimerText",
            CHECKSUM,
            &number[..],
            376,
            string(
                r#"{"flags":1,"history":4,"kind":"as_number","source":{"tag":3,"double":15.614009857177734},"format":{"always_sign":false,"use_grouping":true,"rounding_mode":0,"minimum_integral_digits":2,"maximum_integral_digits":2,"minimum_fractional_digits":2,"maximum_fractional_digits":2},"culture":""}"#,
            ),
        ));
    }
    let mut stats = decode_cases(&cases);
    assert_eq!((stats.decoded_ok, stats.decoded_err), (4, 0));
    // The same bits as `FText`: no string-table key, so both refused.
    for (raw, bits) in [(&empty[..], 72), (&number[..], 376)] {
        assert!(crate::decode_field(FieldType::FText, raw, bits).is_err());
    }
    // A history the tree reader has never seen laid out is a counted,
    // rejected decode, not a guess.
    let mut unknown = number;
    unknown[4] = 5;
    let got = decode(
        &mut stats,
        BOMB_GS,
        "OverrideMatchTimerText",
        CHECKSUM,
        &unknown,
        376,
    );
    assert_eq!(got, NO_VALUE);
    assert_eq!(stats.decoded_err, 1);
}

const DEFAULT_CEREMONY: &str = "/Game/DefaultCeremony.DefaultCeremony_C";
const CLUTCH_CEREMONY: &str = "/Game/ClutchCeremony.ClutchCeremony_C";
const THRIFTY_CEREMONY: &str = "/Game/ThriftyCeremony.ThriftyCeremony_C";
const ON_KILL_EFFECT: &str =
    "/Game/Personalization/Prototypes/OnKillEffect_Base.OnKillEffect_Base_C";
const FLOAT_CONTEXT: &str = "/Game/Characters/States/Contexts/\
FloatTransitionContext.FloatTransitionContext_C";
const EQUIP_CONTEXT: &str = "/Game/Characters/States/Contexts/\
EquipRequestTransitionContext.EquipRequestTransitionContext_C";
const THORNE_SEGMENT: &str = "/Game/Characters/Thorne/S0/Ability_E/\
GameObject_Thorne_E_Wall_Segment_Fortifying.GameObject_Thorne_E_Wall_Segment_Fortifying_C";
const BREACH_FISSURE: &str = "/Game/Characters/Breach/S0/Ability_E/\
GameObject_Breach_E_SweetSpotFissure.GameObject_Breach_E_SweetSpotFissure_C";

/// A sample of the other Blueprint identities, one per type and payload
/// shape, each a real 13.06 payload with the value the independent reader
/// gave it; the full list and its evidence are in the fixture.
#[test]
fn other_blueprint_payloads_decode_to_the_independent_values() {
    let fissure = [
        0x00, 0x00, 0x00, 0x80, 0x23, 0x3b, 0x91, 0xc0, 0x00, 0x00, 0x00, 0xa0, 0xf9, 0x30, 0xac,
        0xc0, 0x00, 0x00, 0x00, 0x80, 0x66, 0x02, 0x79, 0x40,
    ];
    let float_raw = [0x00, 0x00, 0x00, 0x00, 0x54, 0x00, 0xc4, 0x3f];
    let stats = decode_cases(&[
        (
            DEFAULT_CEREMONY,
            "bShouldDisplayCeremony",
            2_636_440_541,
            &[1],
            1,
            bool_(true),
        ),
        // An 8-bit reference is not always null: 0x80 is GUID 64.
        (
            CLUTCH_CEREMONY,
            "ClutchPlayer",
            829_915_424,
            &[0x80],
            8,
            int(64),
        ),
        (
            CLUTCH_CEREMONY,
            "ClutchPlayer",
            829_915_424,
            &[0xb1, 0x04],
            16,
            int(344),
        ),
        // An odd GUID: a static object, here an FXC class in net_guids.
        (
            ON_KILL_EFFECT,
            "Victim FXC",
            3_224_851_082,
            &[0xa3, 0x2c],
            16,
            int(2_897),
        ),
        (
            FLOAT_CONTEXT,
            "Float",
            3_878_297_219,
            &float_raw,
            64,
            float(0.15626001358032227),
        ),
        (
            EQUIP_CONTEXT,
            "TargetEquippable",
            4_028_634_209,
            &[0xf9, 0xdf, 0x02],
            24,
            int(30_716),
        ),
        (
            THORNE_SEGMENT,
            "IsAlive_0",
            445_799_890,
            &[0],
            1,
            bool_(false),
        ),
        (
            THRIFTY_CEREMONY,
            "BlueTeamStartingAvgInventoryValue",
            2_511_444_522,
            &[0x52, 0x0d, 0x00, 0x00],
            32,
            int(3_410),
        ),
        (
            BREACH_FISSURE,
            "CharacterLocation",
            3_040_835_906,
            &fissure,
            192,
            string("(-1102.78466796875,-3608.487548828125,400.1500244140625)"),
        ),
        (
            THRIFTY_CEREMONY,
            "bShouldDisplayCeremony",
            2_636_440_541,
            &[0],
            1,
            bool_(false),
        ),
    ]);
    assert_eq!((stats.decoded_ok, stats.decoded_err), (10, 0));
}

const PROTOTYPE_BOLT: &str = "/Game/Characters/Hunter/S0/Ability_4/AnimationUpdatePrototype/\
Projectile_Hunter_4_ExplosiveBolt_PrototypeBalance.Projectile_Hunter_4_ExplosiveBolt_PrototypeBalance_C";
const OLD_CYPHER_CAMERA: &str = "/Game/Characters/Gumshoe/S0/Ability_Q/\
Pawn_Gumshoe_Q_PossessableCamera.Pawn_Gumshoe_Q_PossessableCamera_C";
const NET_TOSS_DEBUFF: &str = "/Game/Characters/Cable/S0/Ability_4/\
NetTossRemovableDebuff.NetTossRemovableDebuff_C";

/// Paths the 13.06 install no longer has (the camera and tracking dart moved
/// in 13.01; the prototype bolt and the net toss are gone). They are typed on
/// two legs -- the checksum and the corpus -- and, being exact identities,
/// each old path reaches its type only under its own name, not through the
/// current class that carries the same property.
#[test]
fn pre_rename_blueprint_paths_decode_at_their_own_identities() {
    let trail = [
        0x00, 0x00, 0x00, 0x80, 0x0e, 0xa4, 0xa9, 0x40, 0x00, 0x00, 0x00, 0x00, 0x1f, 0xcb, 0x7c,
        0xc0, 0x00, 0x00, 0x00, 0xa0, 0x65, 0x72, 0x95, 0x40,
    ];
    let stats = decode_cases(&[
        (
            PROTOTYPE_BOLT,
            "TrailPosition",
            3_110_715_024,
            &trail,
            192,
            string("(3282.0283203125,-460.695068359375,1372.5992431640625)"),
        ),
        (
            OLD_CYPHER_CAMERA,
            "Possessed",
            2_181_339_745,
            &[1],
            1,
            bool_(true),
        ),
        (
            NET_TOSS_DEBUFF,
            "Target",
            2_924_225_553,
            &[0x99, 0x0e],
            16,
            int(972),
        ),
    ]);
    assert_eq!((stats.decoded_ok, stats.decoded_err), (3, 0));
}
