use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};

pub(super) fn fingerprint(file: &mut File) -> io::Result<(String, u64)> {
    file.seek(SeekFrom::Start(0))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    let mut bytes = 0;
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
        bytes += count as u64;
    }
    file.seek(SeekFrom::Start(0))?;
    Ok((format!("{:x}", hasher.finalize()), bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fingerprint_preserves_stream_position_at_start() {
        use std::io::Write;
        let mut file = tempfile::tempfile().unwrap();
        file.write_all(b"abc").unwrap();
        let (hash, bytes) = fingerprint(&mut file).unwrap();
        assert_eq!(
            hash,
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(bytes, 3);
        assert_eq!(file.stream_position().unwrap(), 0);
    }
}
