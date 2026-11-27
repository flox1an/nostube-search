use anyhow::Result;
use bech32::{Hrp, primitives::checksum::Checksum};

// NIP-19 permits longer strings than the 90-character BIP-173 address limit.
pub(crate) enum Nip19Checksum {}
impl Checksum for Nip19Checksum {
    type MidstateRepr = u32;
    const CODE_LENGTH: usize = 5000;
    const CHECKSUM_LENGTH: usize = 6;
    const GENERATOR_SH: [u32; 5] = [
        0x3b6a_57b2,
        0x2650_8e6d,
        0x1ea1_19fa,
        0x3d42_33dd,
        0x2a14_62b3,
    ];
    const TARGET_RESIDUE: u32 = 1;
}

/// Preserve nostr-tools' descending TLV field order, not merely an equivalent
/// decoded pointer: clients and generated canonical URLs retain exact strings.
pub(crate) fn encode(prefix: &str, fields: &[(u8, &[u8])]) -> Result<String> {
    let mut data = Vec::with_capacity(fields.iter().map(|(_, value)| value.len() + 2).sum());
    for (tag, value) in fields {
        let len = u8::try_from(value.len())?;
        data.extend_from_slice(&[*tag, len]);
        data.extend_from_slice(value);
    }
    Ok(bech32::encode::<Nip19Checksum>(Hrp::parse(prefix)?, &data)?)
}
fn key32(hex_value: &str) -> Result<[u8; 32]> {
    let mut out = [0u8; 32];
    hex::decode_to_slice(hex_value, &mut out)?;
    Ok(out)
}
pub(crate) fn event(id: &str, author: &str) -> Result<String> {
    encode("nevent", &[(2, &key32(author)?), (0, &key32(id)?)])
}
pub(crate) fn address(identifier: &str, author: &str, kind: u32) -> Result<String> {
    encode(
        "naddr",
        &[
            (3, &kind.to_be_bytes()),
            (2, &key32(author)?),
            (0, identifier.as_bytes()),
        ],
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn malformed_keys_are_rejected_not_encoded() {
        assert!(event("", &"22".repeat(32)).is_err());
        assert!(event(&"11".repeat(32), &"22".repeat(31)).is_err());
        assert!(address("x", "", 34235).is_err());
    }
    #[test]
    fn canonical_pointers_match_the_typescript_oracle_exactly() {
        assert_eq!(
            event(&"11".repeat(32), &"22".repeat(32)).unwrap(),
            "nevent1qgszyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygsqyqg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zjwuapy"
        );
        assert_eq!(
            address("intro", &"22".repeat(32), 34235).unwrap(),
            "naddr1qvzqqqy9hvpzqg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zqqzkjmn5wfhsem4dz0"
        );
    }
}
