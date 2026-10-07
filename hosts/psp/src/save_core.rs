//! Pure, host-testable core of the PSP save bridge: path validation and the
//! `sceIoOpen` result classification. No `psp::sys` dependency so the unit
//! tests compile and run on the host (`rustc --test`, see
//! tests/psp-save.test.ts); `save.rs` performs the actual memstick FFI.

/// Device root every save path resolves under. The guest passes
/// `save/slot-1.json` (the same relative path the desktop fs store uses);
/// `resolve` enforces the `save/` prefix so no call can name a file outside
/// the save directory.
pub const ROOT: &[u8] = b"ms0:/PSP/COMMON/pocketjs/";
/// One save file may not exceed this; the guest menu refuses larger saves.
pub const MAX_FILE_BYTES: usize = 1 << 20; // 1 MiB
/// Longest guest-relative path accepted ("save/" + 48 chars).
pub const MAX_REL: usize = 53;
/// SCE_ERROR_ERRNO_ENOENT — the only open/remove failure that means
/// "absent". Every other negative code is a real I/O failure the guest must
/// see as an error, not an empty slot.
pub const ENOENT: u32 = 0x8001_0002;
/// SCE_ERROR_ERRNO_EACCES — a read-only memory stick opens with this.
pub const EACCES: u32 = 0x8001_000d;
/// SCE_ERROR_ERRNO_EIO — a generic device I/O failure.
pub const EIO: u32 = 0x8001_0005;

/// A NUL-terminated device path with room for a 4-byte suffix (.tmp/.bak).
pub type DevicePath = [u8; 132];

/// Validate a `save/...`-relative path and resolve it under [`ROOT`]. The
/// guest passes `save/slot-1.json`; only one path segment is accepted, in
/// the `[A-Za-z0-9._-]` charset, so no call can name a file outside the
/// save directory. Returns the path and its length without the NUL.
pub fn resolve(path: &str) -> Option<(DevicePath, usize)> {
    if !path.starts_with("save/") || path.len() > MAX_REL {
        return None;
    }
    let rest = &path["save/".len()..];
    if rest.is_empty()
        || rest == "."
        || rest == ".."
        || !rest
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
    {
        return None;
    }
    let mut out = [0u8; 132];
    let total = ROOT.len() + path.len();
    if total + 4 >= out.len() {
        return None;
    }
    out[..ROOT.len()].copy_from_slice(ROOT);
    out[ROOT.len()..total].copy_from_slice(path.as_bytes());
    Some((out, total))
}

/// Append a suffix (`.tmp`/`.bak`) to a resolved path; the result stays
/// NUL-terminated because [`DevicePath`] outlives the suffix by one byte.
pub fn with_suffix(path: &DevicePath, len: usize, suffix: &[u8]) -> DevicePath {
    let mut out = *path;
    out[len..len + suffix.len()].copy_from_slice(suffix);
    out
}

/// Classify an `sceIoOpen` result. A non-negative code is a file descriptor;
/// ENOENT is the only failure that means "no such file" (the guest reads it
/// as an empty slot); every other negative code is an I/O failure the guest
/// must surface (a damaged slot), never a silent empty read.
pub fn classify_open(result: i32) -> Result<Option<i32>, ()> {
    if result >= 0 {
        Ok(Some(result))
    } else if (result as u32) == ENOENT {
        Ok(None)
    } else {
        Err(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_of_a_present_file_yields_a_descriptor() {
        assert_eq!(classify_open(0), Ok(Some(0)));
        assert_eq!(classify_open(42), Ok(Some(42)));
    }

    #[test]
    fn open_enoent_means_absent_not_error() {
        // 0x80010002 as the signed i32 sceIoOpen returns.
        assert_eq!(classify_open(ENOENT as i32), Ok(None));
    }

    #[test]
    fn open_other_errors_are_io_failures_not_empty_slots() {
        // A read-only stick (EACCES), a device fault (EIO) and an unmapped
        // negative code must all surface as errors, never "absent".
        assert_eq!(classify_open(EACCES as i32), Err(()));
        assert_eq!(classify_open(EIO as i32), Err(()));
        assert_eq!(classify_open(-1), Err(()));
    }

    #[test]
    fn resolve_accepts_one_segment_under_save() {
        let (p, len) = resolve("save/slot-1.json").expect("valid path");
        assert_eq!(&p[..len], b"ms0:/PSP/COMMON/pocketjs/save/slot-1.json");
        assert_eq!(len, 41);
    }

    #[test]
    fn resolve_rejects_paths_outside_the_save_dir() {
        assert!(resolve("slot-1.json").is_none()); // missing save/ prefix
        assert!(resolve("save/../slot-1.json").is_none()); // traversal
        assert!(resolve("save/sub/slot-1.json").is_none()); // two segments
        assert!(resolve("save/").is_none()); // empty name
        assert!(resolve(&format!("save/{}.json", "a".repeat(60))).is_none()); // too long
    }

    #[test]
    fn suffix_sits_past_the_nul_terminator() {
        let (p, len) = resolve("save/x").unwrap();
        let bak = with_suffix(&p, len, b".bak");
        assert_eq!(&bak[..len], b"ms0:/PSP/COMMON/pocketjs/save/x");
        assert_eq!(&bak[len..len + 4], b".bak");
        assert_eq!(bak[len + 4], 0); // still NUL-terminated
    }
}
