//! Hash algorithms required by the FNS wire protocol.
//!
//! The server uses a JavaScript-compatible 32-bit string hash. Third-party
//! clients must reproduce it bit-for-bit, otherwise path/content comparisons
//! never match and every sync looks like a conflict.

/// JavaScript-compatible 32-bit hash over UTF-16 code units.
///
/// Mirrors `util.EncodeHash32` on the server:
/// `hash = (hash << 5) - hash + char` with wrapping `i32` arithmetic.
pub fn encode_hash32(content: &str) -> String {
    let mut hash: i32 = 0;
    for unit in content.encode_utf16() {
        hash = hash
            .wrapping_shl(5)
            .wrapping_sub(hash)
            .wrapping_add(i32::from(unit));
    }
    hash.to_string()
}

const FILE_HASH_THRESHOLD: usize = 10 * 1024 * 1024;
const FILE_HASH_SLICE_SIZE: usize = 5 * 1024 * 1024;

/// 32-bit hash over raw bytes. Above 10 MiB only the first and last 5 MiB are
/// hashed, matching `util.EncodeHash32Bytes`.
pub fn encode_hash32_bytes(data: &[u8]) -> String {
    let mut hash: i32 = 0;
    let mut push = |byte: u8| {
        hash = hash
            .wrapping_shl(5)
            .wrapping_sub(hash)
            .wrapping_add(i32::from(byte));
    };

    if data.len() <= FILE_HASH_THRESHOLD {
        for &byte in data {
            push(byte);
        }
    } else {
        for &byte in &data[..FILE_HASH_SLICE_SIZE] {
            push(byte);
        }
        for &byte in &data[data.len() - FILE_HASH_SLICE_SIZE..] {
            push(byte);
        }
    }
    hash.to_string()
}

/// Notebook-relative path hash used as the primary key on the server.
pub fn path_hash(path: &str) -> String {
    encode_hash32(path)
}

/// Markdown content hash used for change detection and conflict resolution.
pub fn content_hash(content: &str) -> String {
    encode_hash32(content)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ascii_matches_javascript_algorithm() {
        // h = (((0 * 31 + 97) * 31 + 98) * 31 + 99)
        assert_eq!(encode_hash32("abc"), "96354");
        assert_eq!(encode_hash32(""), "0");
    }

    #[test]
    fn non_bmp_characters_use_utf16_surrogate_pairs() {
        // "😀" is a surrogate pair (0xD83D, 0xDE00) in both JS and Go.
        let mut expected: i32 = 0;
        for unit in [0xD83Du16, 0xDE00u16] {
            expected = expected
                .wrapping_shl(5)
                .wrapping_sub(expected)
                .wrapping_add(i32::from(unit));
        }
        assert_eq!(encode_hash32("😀"), expected.to_string());
    }

    #[test]
    fn bytes_hash_uses_same_recurrence() {
        assert_eq!(encode_hash32_bytes(b"abc"), "96354");
    }

    #[test]
    fn large_input_hashes_only_edges() {
        let mut data = vec![b'a'; FILE_HASH_THRESHOLD + 1];
        data[FILE_HASH_SLICE_SIZE] = b'z'; // middle byte, must be ignored
        let edges_only = {
            let mut copy = data.clone();
            copy[FILE_HASH_SLICE_SIZE] = b'a';
            copy
        };
        assert_eq!(
            encode_hash32_bytes(&data),
            encode_hash32_bytes(&edges_only)
        );
    }
}
