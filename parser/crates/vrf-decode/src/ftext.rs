//! Strict structural decoder for the measured FText histories used by overlays.
//!
//! It preserves wire identifiers and argument trees; it makes no localization
//! or gameplay-meaning inference.
use core::fmt::{self, Write};
use thiserror::Error;
use vrf_bitio::{BitError, BitReader};

const MAX_STRING_BYTES: u64 = 64 * 1024;
const MAX_DEPTH: u16 = 16;
const MAX_NODES: u16 = 256;
const MAX_FORMAT_ARGUMENTS: i32 = 128;

/// A complete measured FText history tree.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FTextTree {
    /// History 4 (`AsNumber`): a number the game formats when it displays the
    /// text. `BombGameState_C.OverrideMatchTimerText` sends it whenever the
    /// match timer is overridden; a double source (argument type 3) is the
    /// only one observed, and the only one read.
    AsNumber {
        flags: u32,
        /// The source double's bits: exact and comparable (`f64` is not
        /// `Eq`). Always finite -- a non-finite value is refused while
        /// decoding, because JSON has no spelling for it.
        source_bits: u64,
        /// `FNumberFormattingOptions`, when the text carries its own.
        format: Option<FTextNumberFormat>,
        /// The target culture's name; empty for the current culture.
        culture: String,
    },
    /// History 11 string-table form.
    StringTable {
        flags: u32,
        table: FTextName,
        key: String,
    },
    /// History 3 format form. Arguments retain their wire order and duplicates.
    Format {
        flags: u32,
        source: Box<FTextTree>,
        arguments: Vec<FTextArgument>,
    },
    /// The observed empty form: history 255 with zero flags and a zero i32
    /// after the history byte. That i32 is most likely Unreal's
    /// `bHasCultureInvariantString` archive bool rather than a length; a 1
    /// would be followed by a string, and is refused as `InvalidEmptyForm`.
    Empty { flags: u32 },
}
/// `FNumberFormattingOptions` in wire order: two archive bools (whole u32s,
/// 0 or 1), the rounding mode as a signed byte, then four i32 digit limits.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FTextNumberFormat {
    pub always_sign: bool,
    pub use_grouping: bool,
    pub rounding_mode: i8,
    pub minimum_integral_digits: i32,
    pub maximum_integral_digits: i32,
    pub minimum_fractional_digits: i32,
    pub maximum_fractional_digits: i32,
}
/// Inline FName from a string-table history.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FTextName {
    pub name: String,
    pub number: i32,
}
/// One ordered format argument.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FTextArgument {
    pub name: String,
    pub tag: u8,
    pub value: FTextArgumentValue,
}
/// Explicitly measured argument forms.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FTextArgumentValue {
    U64Bits(u64),
    Text(Box<FTextTree>),
}
/// Full-tree FText decoding failure.
#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum FTextTreeError {
    #[error(transparent)]
    BitIo(#[from] BitError),
    #[error("unsupported FText history discriminator {discriminator}")]
    UnsupportedHistory { discriminator: u8 },
    #[error("unsupported FText name form")]
    UnsupportedNameForm,
    #[error("FText FName suffix must be nonnegative, got {number}")]
    NegativeNameSuffix { number: i32 },
    #[error("FText format argument count must be in 0..={max}, got {actual}")]
    InvalidArgumentCount { max: i32, actual: i32 },
    #[error("unsupported FText format argument tag {tag}")]
    UnsupportedArgumentTag { tag: u8 },
    #[error("empty FText history must have zero flags and zero length")]
    InvalidEmptyForm,
    #[error("FText string exceeds {max_bytes} byte cap: {bytes} bytes")]
    StringTooLong { bytes: u64, max_bytes: u64 },
    #[error("FText string is missing its NUL terminator")]
    MissingStringTerminator,
    #[error("FText nesting exceeds depth limit {limit}")]
    DepthLimit { limit: u16 },
    #[error("FText node count exceeds limit {limit}")]
    NodeLimit { limit: u16 },
    #[error("FText payload has {remaining} unconsumed bits")]
    TrailingBits { remaining: u64 },
    /// An archive bool is a whole u32; anything but 0 or 1 is not one.
    #[error("FText archive bool must be 0 or 1, got {value}")]
    InvalidBool { value: u32 },
    /// A history-4 source double that is NaN or infinite has no JSON spelling.
    #[error("FText number is not finite")]
    NonFiniteNumber,
}

/// Decode an exact bit window containing only measured FText histories 11, 3,
/// 4 and the observed 255 empty form. Raw u64 argument bits remain unsigned.
pub fn decode_ftext_tree(data: &[u8], bit_count: u32) -> Result<FTextTree, FTextTreeError> {
    let mut r = BitReader::with_bit_len(data, u64::from(bit_count))?;
    let value = decode_ftext_tree_from(&mut r)?;
    if r.bits_remaining() != 0 {
        return Err(FTextTreeError::TrailingBits {
            remaining: r.bits_remaining(),
        });
    }
    Ok(value)
}
/// [`decode_ftext_tree`] on a reader already at the payload, for
/// `FieldType::FTextTree`. The trailing-bit check is the caller's:
/// `decode_field` refuses leftover bits for every type alike.
pub(crate) fn decode_ftext_tree_from(r: &mut BitReader<'_>) -> Result<FTextTree, FTextTreeError> {
    let mut nodes = 0;
    decode_tree(r, 0, &mut nodes)
}
impl FTextTree {
    /// The wire history byte.
    pub(crate) fn history(&self) -> u8 {
        match self {
            Self::AsNumber { .. } => 4,
            Self::StringTable { .. } => 11,
            Self::Format { .. } => 3,
            Self::Empty { .. } => 255,
        }
    }

    /// JSON for additive `value_str`; it retains flags, history and wire values.
    #[must_use]
    pub fn to_json(&self) -> String {
        let mut s = String::new();
        self.write_json(&mut s).expect("String write");
        s
    }
    fn write_json(&self, s: &mut String) -> fmt::Result {
        match self {
            Self::StringTable { flags, table, key } => {
                write!(
                    s,
                    r#"{{"flags":{flags},"history":11,"kind":"string_table","table":{{"name":"#
                )?;
                json_string(s, &table.name)?;
                write!(s, r#","number":{}}},"key":"#, table.number)?;
                json_string(s, key)?;
                s.push('}');
                Ok(())
            }
            Self::Format {
                flags,
                source,
                arguments,
            } => {
                write!(
                    s,
                    r#"{{"flags":{flags},"history":3,"kind":"format","source":"#
                )?;
                source.write_json(s)?;
                s.push_str(r#","arguments":["#);
                for (i, a) in arguments.iter().enumerate() {
                    if i > 0 {
                        s.push(',');
                    }
                    s.push_str(r#"{"name":"#);
                    json_string(s, &a.name)?;
                    write!(s, r#","tag":{},"value":"#, a.tag)?;
                    match &a.value {
                        FTextArgumentValue::U64Bits(v) => write!(s, r#"{{"bits_u64":"{v}"}}"#)?,
                        FTextArgumentValue::Text(v) => v.write_json(s)?,
                    };
                    s.push('}');
                }
                s.push_str("]}");
                Ok(())
            }
            Self::Empty { flags } => {
                write!(s, r#"{{"flags":{flags},"history":255,"kind":"empty"}}"#)
            }
            Self::AsNumber {
                flags,
                source_bits,
                format,
                culture,
            } => {
                // `{}`: shortest round-trip spelling, never exponent form.
                write!(
                    s,
                    r#"{{"flags":{flags},"history":4,"kind":"as_number","source":{{"tag":3,"double":{}}},"format":"#,
                    f64::from_bits(*source_bits)
                )?;
                match format {
                    Some(f) => write!(
                        s,
                        r#"{{"always_sign":{},"use_grouping":{},"rounding_mode":{},"minimum_integral_digits":{},"maximum_integral_digits":{},"minimum_fractional_digits":{},"maximum_fractional_digits":{}}}"#,
                        f.always_sign,
                        f.use_grouping,
                        f.rounding_mode,
                        f.minimum_integral_digits,
                        f.maximum_integral_digits,
                        f.minimum_fractional_digits,
                        f.maximum_fractional_digits
                    )?,
                    None => s.push_str("null"),
                }
                s.push_str(r#","culture":"#);
                json_string(s, culture)?;
                s.push('}');
                Ok(())
            }
        }
    }
}

/// Charge one node (each tree and each format argument) against the budget;
/// the first charge past `MAX_NODES` (256) returns, so `+= 1` cannot overflow.
fn charge_node_budget(nodes: &mut u16) -> Result<(), FTextTreeError> {
    *nodes += 1;
    if *nodes > MAX_NODES {
        return Err(FTextTreeError::NodeLimit { limit: MAX_NODES });
    }
    Ok(())
}

fn decode_tree(
    r: &mut BitReader<'_>,
    depth: u16,
    nodes: &mut u16,
) -> Result<FTextTree, FTextTreeError> {
    if depth >= MAX_DEPTH {
        return Err(FTextTreeError::DepthLimit { limit: MAX_DEPTH });
    }
    charge_node_budget(nodes)?;
    let flags = r.read_bits(32)? as u32;
    let history = r.read_bits(8)? as u8;
    match history {
        11 => {
            if r.read_bit()? {
                return Err(FTextTreeError::UnsupportedNameForm);
            };
            let name = read_string(r)?;
            let number = r.read_i32()?;
            if number < 0 {
                return Err(FTextTreeError::NegativeNameSuffix { number });
            };
            let key = read_string(r)?;
            Ok(FTextTree::StringTable {
                flags,
                table: FTextName { name, number },
                key,
            })
        }
        3 => {
            let source = Box::new(decode_tree(r, depth + 1, nodes)?);
            let actual = r.read_i32()?;
            if !(0..=MAX_FORMAT_ARGUMENTS).contains(&actual) {
                return Err(FTextTreeError::InvalidArgumentCount {
                    max: MAX_FORMAT_ARGUMENTS,
                    actual,
                });
            };
            let mut arguments = Vec::with_capacity(actual as usize);
            for _ in 0..actual {
                charge_node_budget(nodes)?;
                let name = read_string(r)?;
                let tag = r.read_bits(8)? as u8;
                let value = match tag {
                    0 => FTextArgumentValue::U64Bits(r.read_u64()?),
                    4 => FTextArgumentValue::Text(Box::new(decode_tree(r, depth + 1, nodes)?)),
                    _ => return Err(FTextTreeError::UnsupportedArgumentTag { tag }),
                };
                arguments.push(FTextArgument { name, tag, value });
            }
            Ok(FTextTree::Format {
                flags,
                source,
                arguments,
            })
        }
        4 => {
            // `FFormatArgumentValue`: a type byte, then the value. Only a
            // double (3) has been observed; any other type is refused rather
            // than read with a guessed width.
            let tag = r.read_bits(8)? as u8;
            if tag != 3 {
                return Err(FTextTreeError::UnsupportedArgumentTag { tag });
            }
            let source = r.read_f64()?;
            if !source.is_finite() {
                return Err(FTextTreeError::NonFiniteNumber);
            }
            let format = if read_archive_bool(r)? {
                Some(FTextNumberFormat {
                    always_sign: read_archive_bool(r)?,
                    use_grouping: read_archive_bool(r)?,
                    rounding_mode: r.read_bits(8)? as u8 as i8,
                    minimum_integral_digits: r.read_i32()?,
                    maximum_integral_digits: r.read_i32()?,
                    minimum_fractional_digits: r.read_i32()?,
                    maximum_fractional_digits: r.read_i32()?,
                })
            } else {
                None
            };
            let culture = read_string(r)?;
            Ok(FTextTree::AsNumber {
                flags,
                source_bits: source.to_bits(),
                format,
                culture,
            })
        }
        255 => {
            if flags != 0 || r.read_i32()? != 0 {
                Err(FTextTreeError::InvalidEmptyForm)
            } else {
                Ok(FTextTree::Empty { flags })
            }
        }
        _ => Err(FTextTreeError::UnsupportedHistory {
            discriminator: history,
        }),
    }
}
/// An archive `bool`: Unreal serializes it as a whole u32.
fn read_archive_bool(r: &mut BitReader<'_>) -> Result<bool, FTextTreeError> {
    match r.read_u32()? {
        0 => Ok(false),
        1 => Ok(true),
        value => Err(FTextTreeError::InvalidBool { value }),
    }
}
/// A length past the payload is `InvalidLength`, as `read_fstring` reports it.
fn read_string(r: &mut BitReader<'_>) -> Result<String, FTextTreeError> {
    let start = r.position();
    let length = r.read_i32()?;
    if length == 0 {
        return Ok(String::new());
    };
    // A positive length counts UTF-8 bytes, a negative one UTF-16 units.
    let wide = length < 0;
    let units = u64::from(length.unsigned_abs());
    let bytes = units.saturating_mul(if wide { 2 } else { 1 });
    if bytes > MAX_STRING_BYTES {
        return Err(FTextTreeError::StringTooLong {
            bytes,
            max_bytes: MAX_STRING_BYTES,
        });
    };
    if bytes * 8 > r.bits_remaining() {
        let length = i64::from(length);
        return Err(BitError::InvalidLength {
            position: start,
            length,
        }
        .into());
    }
    let width = if wide { 16 } else { 8 };
    let mut v = Vec::with_capacity(units as usize);
    for _ in 0..units {
        v.push(r.read_bits(width)? as u16);
    }
    if v.pop() != Some(0) {
        return Err(FTextTreeError::MissingStringTerminator);
    };
    let text = if wide {
        String::from_utf16(&v).ok()
    } else {
        String::from_utf8(v.into_iter().map(|unit| unit as u8).collect()).ok()
    };
    text.ok_or_else(|| BitError::InvalidString { position: start }.into())
}
fn json_string(s: &mut String, value: &str) -> fmt::Result {
    s.push('"');
    for c in value.chars() {
        match c {
            '"' => s.push_str("\\\""),
            '\\' => s.push_str("\\\\"),
            '\n' => s.push_str("\\n"),
            '\r' => s.push_str("\\r"),
            '\t' => s.push_str("\\t"),
            c if c <= '\u{1f}' => write!(s, "\\u{:04x}", c as u32)?,
            c => s.push(c),
        }
    }
    s.push('"');
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use vrf_testkit::{BitWrite, BitWriter};

    /// The FText pieces these tests assemble, on the shared writer.
    trait FTextBits {
        fn string(&mut self, value: &str) -> &mut Self;
        /// Flags and history 11, then the inline-name bit: a string table's head.
        fn table_head(&mut self, flags: u32) -> &mut Self;
        fn table(&mut self, flags: u32, name: &str, number: i32, key: &str) -> &mut Self;
        /// Flags, history 3 and an empty source: a format history up to its count.
        fn format_head(&mut self, flags: u32) -> &mut Self;
        /// Flags and history 4, then a double source: an `AsNumber` up to its options.
        fn number_head(&mut self, flags: u32, value: f64) -> &mut Self;
        fn empty(&mut self) -> &mut Self;
    }

    impl FTextBits for BitWriter {
        fn string(&mut self, value: &str) -> &mut Self {
            self.i32((value.len() + 1) as i32)
                .bytes(value.as_bytes())
                .u8(0)
        }
        fn table_head(&mut self, flags: u32) -> &mut Self {
            self.u32(flags).u8(11).bit(false)
        }
        fn table(&mut self, flags: u32, name: &str, number: i32, key: &str) -> &mut Self {
            self.table_head(flags).string(name).i32(number).string(key)
        }
        fn format_head(&mut self, flags: u32) -> &mut Self {
            self.u32(flags).u8(3).empty()
        }
        fn number_head(&mut self, flags: u32, value: f64) -> &mut Self {
            self.u32(flags).u8(4).u8(3).bits(value.to_bits(), 64)
        }
        fn empty(&mut self) -> &mut Self {
            self.u32(0).u8(255).i32(0)
        }
    }

    fn decode(bits: &BitWriter) -> Result<FTextTree, FTextTreeError> {
        let (raw, count) = bits.finish();
        decode_ftext_tree(&raw, count)
    }

    #[test]
    fn string_table_preserves_suffix_and_escapes_json() {
        let tree = decode(BitWriter::new().table(7, "Table\\Name", 2, "line\n\"key")).unwrap();
        assert_eq!(
            tree.to_json(),
            r#"{"flags":7,"history":11,"kind":"string_table","table":{"name":"Table\\Name","number":2},"key":"line\n\"key"}"#
        );
    }

    #[test]
    fn format_keeps_duplicate_names_and_unsigned_bits() {
        let mut bits = BitWriter::new();
        bits.u32(9).u8(3).table(0, "T", 0, "Source").i32(2);
        bits.string("same").u8(0).bits(u64::MAX, 64);
        bits.string("same").u8(4).empty();
        let json = decode(&bits).unwrap().to_json();
        assert!(json.contains(r#""bits_u64":"18446744073709551615""#));
        assert_eq!(json.matches(r#""name":"same""#).count(), 2);
    }

    #[test]
    fn format_accepts_zero_one_and_two_arguments() {
        for count in 0..=2 {
            let mut bits = BitWriter::new();
            bits.format_head(0).i32(count);
            for index in 0..count {
                bits.string("arg").u8(0).bits(index as u64, 64);
            }
            let FTextTree::Format { arguments, .. } = decode(&bits).unwrap() else {
                panic!("format history");
            };
            assert_eq!(arguments.len(), count as usize);
        }
    }

    #[test]
    fn rejects_bad_terminator_count_tag_flags_and_residual() {
        assert!(matches!(
            decode(BitWriter::new().table_head(0).i32(2).bytes(b"AX")),
            Err(FTextTreeError::MissingStringTerminator)
        ));
        for count in [-1, 129] {
            assert!(matches!(
                decode(BitWriter::new().format_head(0).i32(count)),
                Err(FTextTreeError::InvalidArgumentCount { .. })
            ));
        }
        let mut tag = BitWriter::new();
        tag.format_head(0).i32(2).string("first").u8(0).bits(1, 64);
        tag.string("second").u8(99);
        assert!(matches!(
            decode(&tag),
            Err(FTextTreeError::UnsupportedArgumentTag { tag: 99 })
        ));
        assert!(matches!(
            decode(BitWriter::new().u32(1).u8(255).i32(0)),
            Err(FTextTreeError::InvalidEmptyForm)
        ));
        assert!(matches!(
            decode(BitWriter::new().empty().bit(true)),
            Err(FTextTreeError::TrailingBits { .. })
        ));
    }

    /// A real `OverrideMatchTimerText` payload (13.06, 376 bits): flags 1,
    /// history 4, a double source, format options present, empty culture.
    const TIMER_TEXT: [u8; 47] = [
        0x01, 0x00, 0x00, 0x00, 0x04, 0x03, 0x00, 0x00, 0x00, 0x80, 0x5f, 0x3a, 0x2f, 0x40, 0x01,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00,
        0x00, 0x02, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00,
    ];

    #[test]
    fn as_number_keeps_the_measured_timer_text_exact() {
        let tree = decode_ftext_tree(&TIMER_TEXT, 376).unwrap();
        let FTextTree::AsNumber {
            flags,
            source_bits,
            format,
            ref culture,
        } = tree
        else {
            panic!("history 4: {tree:?}");
        };
        assert_eq!(
            (flags, f64::from_bits(source_bits)),
            (1, 15.614009857177734)
        );
        assert_eq!(
            format,
            Some(FTextNumberFormat {
                always_sign: false,
                use_grouping: true,
                rounding_mode: 0,
                minimum_integral_digits: 2,
                maximum_integral_digits: 2,
                minimum_fractional_digits: 2,
                maximum_fractional_digits: 2,
            })
        );
        assert_eq!(culture, "");
        assert_eq!(
            tree.to_json(),
            r#"{"flags":1,"history":4,"kind":"as_number","source":{"tag":3,"double":15.614009857177734},"format":{"always_sign":false,"use_grouping":true,"rounding_mode":0,"minimum_integral_digits":2,"maximum_integral_digits":2,"minimum_fractional_digits":2,"maximum_fractional_digits":2},"culture":""}"#
        );
        // One byte short is a truncation, one byte over is residue.
        assert!(matches!(
            decode_ftext_tree(&TIMER_TEXT[..46], 368),
            Err(FTextTreeError::BitIo(_))
        ));
        let mut long = TIMER_TEXT.to_vec();
        long.push(0);
        assert!(matches!(
            decode_ftext_tree(&long, 384),
            Err(FTextTreeError::TrailingBits { remaining: 8 })
        ));
    }

    #[test]
    fn as_number_reads_the_no_options_branch_and_a_culture() {
        let mut bits = BitWriter::new();
        bits.number_head(0, -2.5).u32(0).string("ko-KR");
        assert_eq!(
            decode(&bits).unwrap().to_json(),
            r#"{"flags":0,"history":4,"kind":"as_number","source":{"tag":3,"double":-2.5},"format":null,"culture":"ko-KR"}"#
        );
    }

    /// The option members in Unreal's `FNumberFormattingOptions` order. The
    /// corpus cannot pin it -- every observed digit limit is 2 -- so distinct
    /// values do, and a negative rounding byte stays signed.
    #[test]
    fn as_number_format_options_keep_their_wire_order() {
        let mut bits = BitWriter::new();
        bits.number_head(0, 1.0).u32(1).u32(1).u32(0).u8(0xff);
        bits.i32(1).i32(2).i32(3).i32(4).i32(0);
        let FTextTree::AsNumber { format, .. } = decode(&bits).unwrap() else {
            panic!("history 4");
        };
        assert_eq!(
            format,
            Some(FTextNumberFormat {
                always_sign: true,
                use_grouping: false,
                rounding_mode: -1,
                minimum_integral_digits: 1,
                maximum_integral_digits: 2,
                minimum_fractional_digits: 3,
                maximum_fractional_digits: 4,
            })
        );
    }

    #[test]
    fn as_number_refuses_other_sources_bad_bools_and_non_finite_values() {
        let number = |tag: u8, value: f64, has_format: u32, always_sign: u32| {
            let mut bits = BitWriter::new();
            bits.u32(1)
                .u8(4)
                .u8(tag)
                .bits(value.to_bits(), 64)
                .u32(has_format);
            if has_format == 1 {
                bits.u32(always_sign).u32(1).u8(0);
                bits.i32(2).i32(2).i32(2).i32(2);
            }
            decode(bits.i32(0))
        };
        assert!(number(3, 1.5, 1, 0).is_ok());
        // A float source (2) is four bytes, not eight: refused, not misread.
        assert!(matches!(
            number(2, 1.5, 1, 0),
            Err(FTextTreeError::UnsupportedArgumentTag { tag: 2 })
        ));
        assert!(matches!(
            number(3, f64::NAN, 1, 0),
            Err(FTextTreeError::NonFiniteNumber)
        ));
        assert!(matches!(
            number(3, 1.5, 2, 0),
            Err(FTextTreeError::InvalidBool { value: 2 })
        ));
        assert!(matches!(
            number(3, 1.5, 1, 7),
            Err(FTextTreeError::InvalidBool { value: 7 })
        ));
    }

    #[test]
    fn unicode_strings_are_strict_and_byte_bounded() {
        let mut valid = BitWriter::new();
        valid.table_head(0).i32(-3).u16(0xd83d).u16(0xde00).u16(0);
        valid.i32(0).string("Key");
        let FTextTree::StringTable { table, .. } = decode(&valid).unwrap() else {
            panic!("string table");
        };
        assert_eq!(table.name, "\u{1f600}");

        for (length, units, width) in [(2, [0xff, 0], 8), (-2, [0xd800, 0], 16)] {
            let mut invalid = BitWriter::new();
            invalid.table_head(0).i32(length);
            for unit in units {
                invalid.bits(unit, width);
            }
            assert!(matches!(
                decode(&invalid),
                Err(FTextTreeError::BitIo(BitError::InvalidString { .. }))
            ));
        }
        for length in [65_537, -32_769, i32::MIN] {
            assert!(matches!(
                decode(BitWriter::new().table_head(0).i32(length)),
                Err(FTextTreeError::StringTooLong { .. })
            ));
        }
        // Under the cap but past the window: the prefix is at fault, not an EOF.
        assert_eq!(
            decode(BitWriter::new().table_head(0).i32(1000).repeat(false, 128)),
            Err(FTextTreeError::BitIo(BitError::InvalidLength {
                position: 41,
                length: 1000
            }))
        );
    }

    #[test]
    fn depth_and_total_node_budgets_reject_otherwise_complete_trees() {
        for levels in [MAX_DEPTH - 1, MAX_DEPTH] {
            let mut nested = BitWriter::new();
            for _ in 0..levels {
                nested.u32(0).u8(3);
            }
            nested.empty();
            for _ in 0..levels {
                nested.i32(0);
            }
            if levels < MAX_DEPTH {
                assert!(decode(&nested).is_ok());
            } else {
                assert!(matches!(
                    decode(&nested),
                    Err(FTextTreeError::DepthLimit { .. })
                ));
            }
        }
        // Root + source + (one argument and one text per entry): the final
        // argument crosses the global budget while its local count is valid.
        for arguments in [127, 128] {
            let mut wide = BitWriter::new();
            wide.format_head(0).i32(arguments);
            for _ in 0..arguments {
                wide.string("arg").u8(4).empty();
            }
            if arguments == 127 {
                assert!(decode(&wide).is_ok());
            } else {
                assert!(matches!(
                    decode(&wide),
                    Err(FTextTreeError::NodeLimit { .. })
                ));
            }
        }
    }
}
