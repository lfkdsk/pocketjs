//! Pure, host-testable core of the PSP save bridge.
//!
//! This module has no `psp::sys` dependency. It owns path validation, the
//! checksummed on-disk record, read selection, and the ordered write/delete
//! plans. `save.rs` executes those plans against the memory stick; the tests
//! below execute the same plans against a small in-memory filesystem and cut
//! power or fail every individual step.

/// Device root every save path resolves under. The guest passes
/// `save/slot-1.json` (the same relative path the desktop fs store uses);
/// `resolve` enforces the `save/` prefix so no call can name a file outside
/// the save directory.
pub const ROOT: &[u8] = b"ms0:/PSP/COMMON/pocketjs/";
/// One guest payload may not exceed this; the guest menu refuses larger saves.
pub const MAX_FILE_BYTES: usize = 1 << 20; // 1 MiB
/// A framed save adds this fixed header to the guest payload.
pub const RECORD_HEADER_BYTES: usize = 16;
/// Largest physical live/tmp/backup file accepted by the host.
pub const MAX_STORED_BYTES: usize = MAX_FILE_BYTES + RECORD_HEADER_BYTES;
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

const RECORD_MAGIC: &[u8; 8] = b"PJSAVE1\n";

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
/// ENOENT is the only failure that means "no such file". Every other negative
/// code is an I/O failure, never an empty slot.
pub fn classify_open(result: i32) -> Result<Option<i32>, ()> {
    if result >= 0 {
        Ok(Some(result))
    } else if (result as u32) == ENOENT {
        Ok(None)
    } else {
        Err(())
    }
}

/// FNV-1a over the exact guest bytes. The game envelope has its own semantic
/// checksum; this host checksum detects torn/truncated physical files before
/// choosing live over backup.
pub fn record_checksum(bytes: &[u8]) -> u32 {
    let mut hash = 0x811c_9dc5u32;
    for &byte in bytes {
        hash ^= byte as u32;
        hash = hash.wrapping_mul(0x0100_0193);
    }
    hash
}

/// Header written before each guest payload: magic, little-endian byte length,
/// and little-endian checksum. `None` enforces the public 1 MiB payload cap.
pub fn record_header(bytes: &[u8]) -> Option<[u8; RECORD_HEADER_BYTES]> {
    if bytes.len() > MAX_FILE_BYTES {
        return None;
    }
    let mut header = [0u8; RECORD_HEADER_BYTES];
    header[..8].copy_from_slice(RECORD_MAGIC);
    header[8..12].copy_from_slice(&(bytes.len() as u32).to_le_bytes());
    header[12..16].copy_from_slice(&record_checksum(bytes).to_le_bytes());
    Some(header)
}

/// Locate and validate a stored record's guest payload. New records require
/// an exact physical length and checksum. Plain JSON is accepted as a legacy
/// pre-header save so existing memory sticks remain loadable; the game's own
/// envelope checksum remains the final validator for that compatibility path.
pub fn record_span(bytes: &[u8]) -> Result<(usize, usize), ()> {
    if bytes.len() > MAX_STORED_BYTES {
        return Err(());
    }
    if bytes.starts_with(RECORD_MAGIC) {
        if bytes.len() < RECORD_HEADER_BYTES {
            return Err(());
        }
        let len = u32::from_le_bytes(bytes[8..12].try_into().map_err(|_| ())?) as usize;
        let expected = u32::from_le_bytes(bytes[12..16].try_into().map_err(|_| ())?);
        if len > MAX_FILE_BYTES || bytes.len() != RECORD_HEADER_BYTES + len {
            return Err(());
        }
        let payload = &bytes[RECORD_HEADER_BYTES..];
        if record_checksum(payload) != expected {
            return Err(());
        }
        return Ok((RECORD_HEADER_BYTES, len));
    }

    // Fix-3 upgrades an existing on-device format. Old files are the kit's
    // compact JSON envelope, so require its complete outer braces and UTF-8.
    if bytes.len() <= MAX_FILE_BYTES
        && bytes.first() == Some(&b'{')
        && bytes.last() == Some(&b'}')
        && core::str::from_utf8(bytes).is_ok()
    {
        return Ok((0, bytes.len()));
    }
    Err(())
}

/// What probing one physical copy discovered.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CopyStatus {
    Absent,
    Valid,
    Invalid,
    IoError,
}

/// Which validated copy a logical read should return.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ReadSource {
    Live,
    Backup,
}

/// Prefer a validated live copy, otherwise a validated backup. Only two
/// absent files mean an empty slot; corruption or I/O without a valid fallback
/// is an error.
pub fn select_read(live: CopyStatus, backup: CopyStatus) -> Result<Option<ReadSource>, ()> {
    if live == CopyStatus::Valid {
        Ok(Some(ReadSource::Live))
    } else if backup == CopyStatus::Valid {
        Ok(Some(ReadSource::Backup))
    } else if live == CopyStatus::Absent && backup == CopyStatus::Absent {
        Ok(None)
    } else {
        Err(())
    }
}

/// One externally visible step in an atomic replacement. These steps are the
/// contract executed by `save.rs` and exhaustively faulted in this module's
/// host tests.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WriteStep {
    WriteTemp,
    SyncTemp,
    ValidateTemp,
    RemoveBackup,
    MoveLiveToBackup,
    RemoveInvalidLive,
    MoveTempToLive,
    SyncCommitted,
}

const MAX_WRITE_STEPS: usize = 8;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct WritePlan {
    steps: [WriteStep; MAX_WRITE_STEPS],
    len: usize,
}

impl WritePlan {
    fn new() -> Self {
        Self {
            steps: [WriteStep::WriteTemp; MAX_WRITE_STEPS],
            len: 0,
        }
    }

    fn push(&mut self, step: WriteStep) {
        self.steps[self.len] = step;
        self.len += 1;
    }

    pub fn steps(&self) -> &[WriteStep] {
        &self.steps[..self.len]
    }
}

/// Plan a replacement without touching storage. A valid live copy may replace
/// an older backup because it remains readable until it is moved into that
/// backup slot. When backup is the only valid old copy, the plan never removes
/// or renames it: invalid live is removed, then temp becomes live. The backup
/// is retained after success as the previous complete generation.
pub fn write_plan(live: CopyStatus, backup: CopyStatus) -> Result<WritePlan, ()> {
    if live == CopyStatus::IoError || backup == CopyStatus::IoError {
        return Err(());
    }
    let mut plan = WritePlan::new();
    plan.push(WriteStep::WriteTemp);
    plan.push(WriteStep::SyncTemp);
    plan.push(WriteStep::ValidateTemp);
    if live == CopyStatus::Valid {
        if backup != CopyStatus::Absent {
            plan.push(WriteStep::RemoveBackup);
        }
        plan.push(WriteStep::MoveLiveToBackup);
    } else if live == CopyStatus::Invalid {
        plan.push(WriteStep::RemoveInvalidLive);
    }
    plan.push(WriteStep::MoveTempToLive);
    plan.push(WriteStep::SyncCommitted);
    Ok(plan)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DeleteStep {
    RemoveLive,
    RemoveBackup,
}

/// Order a two-copy delete so a failed operation is reported while one valid
/// copy still represents the failed (not successful) deletion. If live is
/// valid, backup goes first; if backup is the only valid copy, invalid/absent
/// live goes first.
pub fn delete_plan(live: CopyStatus, backup: CopyStatus) -> Result<[DeleteStep; 2], ()> {
    if live == CopyStatus::IoError || backup == CopyStatus::IoError {
        return Err(());
    }
    if live == CopyStatus::Valid {
        Ok([DeleteStep::RemoveBackup, DeleteStep::RemoveLive])
    } else {
        Ok([DeleteStep::RemoveLive, DeleteStep::RemoveBackup])
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
        assert_eq!(classify_open(ENOENT as i32), Ok(None));
    }

    #[test]
    fn open_other_errors_are_io_failures_not_empty_slots() {
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
        assert!(resolve("slot-1.json").is_none());
        assert!(resolve("save/../slot-1.json").is_none());
        assert!(resolve("save/sub/slot-1.json").is_none());
        assert!(resolve("save/").is_none());
        assert!(resolve(&format!("save/{}.json", "a".repeat(60))).is_none());
    }

    #[test]
    fn suffix_sits_past_the_nul_terminator() {
        let (p, len) = resolve("save/x").unwrap();
        let bak = with_suffix(&p, len, b".bak");
        assert_eq!(&bak[..len], b"ms0:/PSP/COMMON/pocketjs/save/x");
        assert_eq!(&bak[len..len + 4], b".bak");
        assert_eq!(bak[len + 4], 0);
    }

    fn framed(payload: &[u8]) -> Vec<u8> {
        let mut bytes = record_header(payload).unwrap().to_vec();
        bytes.extend_from_slice(payload);
        bytes
    }

    #[test]
    fn physical_record_checks_exact_length_and_checksum() {
        let payload = br#"{"format":"rpgkit-save/v1"}"#;
        let bytes = framed(payload);
        assert_eq!(
            record_span(&bytes),
            Ok((RECORD_HEADER_BYTES, payload.len()))
        );

        let mut truncated = bytes.clone();
        truncated.pop();
        assert_eq!(record_span(&truncated), Err(()));

        let mut edited = bytes.clone();
        *edited.last_mut().unwrap() ^= 1;
        assert_eq!(record_span(&edited), Err(()));

        let mut trailing = bytes.clone();
        trailing.push(0);
        assert_eq!(record_span(&trailing), Err(()));
    }

    #[test]
    fn complete_legacy_json_remains_readable_but_partial_json_does_not() {
        let legacy = br#"{"format":"rpgkit-save/v1"}"#;
        assert_eq!(record_span(legacy), Ok((0, legacy.len())));
        assert_eq!(record_span(&legacy[..legacy.len() - 1]), Err(()));
        assert_eq!(record_span(b"not a save"), Err(()));
    }

    #[test]
    fn read_uses_only_validated_live_or_validated_backup() {
        use CopyStatus::*;
        assert_eq!(select_read(Valid, Valid), Ok(Some(ReadSource::Live)));
        assert_eq!(select_read(Invalid, Valid), Ok(Some(ReadSource::Backup)));
        assert_eq!(select_read(Absent, Valid), Ok(Some(ReadSource::Backup)));
        assert_eq!(select_read(IoError, Valid), Ok(Some(ReadSource::Backup)));
        assert_eq!(select_read(Absent, Absent), Ok(None));
        assert_eq!(select_read(Invalid, Absent), Err(()));
        assert_eq!(select_read(Absent, Invalid), Err(()));
        assert_eq!(select_read(IoError, Absent), Err(()));
    }

    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    enum Value {
        Old,
        New,
        Invalid,
    }

    #[derive(Clone, Copy, Debug)]
    struct Model {
        live: Option<Value>,
        backup: Option<Value>,
        temp: Option<Value>,
    }

    impl Model {
        fn from_status(live: CopyStatus, backup: CopyStatus) -> Self {
            fn value(status: CopyStatus) -> Option<Value> {
                match status {
                    CopyStatus::Absent => None,
                    CopyStatus::Valid => Some(Value::Old),
                    CopyStatus::Invalid => Some(Value::Invalid),
                    CopyStatus::IoError => panic!("I/O errors have no write plan"),
                }
            }
            Self {
                live: value(live),
                backup: value(backup),
                temp: None,
            }
        }

        fn readable(&self) -> Option<Value> {
            match self.live {
                Some(Value::Old | Value::New) => self.live,
                _ => match self.backup {
                    Some(Value::Old | Value::New) => self.backup,
                    _ => None,
                },
            }
        }

        fn statuses(&self) -> (CopyStatus, CopyStatus) {
            fn status(value: Option<Value>) -> CopyStatus {
                match value {
                    None => CopyStatus::Absent,
                    Some(Value::Old | Value::New) => CopyStatus::Valid,
                    Some(Value::Invalid) => CopyStatus::Invalid,
                }
            }
            (status(self.live), status(self.backup))
        }

        fn apply(&mut self, step: WriteStep) {
            match step {
                WriteStep::WriteTemp => self.temp = Some(Value::New),
                WriteStep::SyncTemp | WriteStep::ValidateTemp | WriteStep::SyncCommitted => {}
                WriteStep::RemoveBackup => self.backup = None,
                WriteStep::MoveLiveToBackup => {
                    assert!(self.backup.is_none());
                    self.backup = self.live.take();
                }
                WriteStep::RemoveInvalidLive => {
                    assert_eq!(self.live, Some(Value::Invalid));
                    self.live = None;
                }
                WriteStep::MoveTempToLive => {
                    assert!(self.live.is_none());
                    self.live = self.temp.take();
                }
            }
        }

        fn fail(&mut self, step: WriteStep) {
            // A failed/partial temp write can leave invalid scratch bytes.
            // Rename/remove/sync failures leave the logical copies as they
            // were immediately before the attempted operation.
            if step == WriteStep::WriteTemp {
                self.temp = Some(Value::Invalid);
            }
        }
    }

    #[test]
    fn every_write_step_failure_and_power_cut_keeps_an_old_or_new_save() {
        use CopyStatus::*;
        let states = [Absent, Valid, Invalid];
        let mut scenarios = 0;
        let mut injected_failures = 0;
        let mut injected_power_cuts = 0;
        for live in states {
            for backup in states {
                let initial = Model::from_status(live, backup);
                if initial.readable().is_none() {
                    continue;
                }
                scenarios += 1;
                let plan = write_plan(live, backup).unwrap();

                for fail_at in 0..plan.steps().len() {
                    let mut model = initial;
                    for &step in &plan.steps()[..fail_at] {
                        model.apply(step);
                    }
                    model.fail(plan.steps()[fail_at]);
                    assert!(
                        model.readable().is_some(),
                        "failure {fail_at} in {live:?}/{backup:?}: {model:?}"
                    );
                    injected_failures += 1;
                }

                let mut model = initial;
                for (cut_after, &step) in plan.steps().iter().enumerate() {
                    model.apply(step);
                    assert!(
                        model.readable().is_some(),
                        "power after {cut_after} in {live:?}/{backup:?}: {model:?}"
                    );
                    injected_power_cuts += 1;
                }
                assert_eq!(model.live, Some(Value::New));
            }
        }
        assert_eq!(scenarios, 5);
        assert_eq!(injected_failures, injected_power_cuts);
        assert!(injected_failures >= 27);
    }

    #[test]
    fn sole_backup_retry_never_removes_the_backup_before_new_live_exists() {
        use CopyStatus::*;
        let plan = write_plan(Absent, Valid).unwrap();
        assert_eq!(
            plan.steps(),
            &[
                WriteStep::WriteTemp,
                WriteStep::SyncTemp,
                WriteStep::ValidateTemp,
                WriteStep::MoveTempToLive,
                WriteStep::SyncCommitted,
            ],
        );

        let mut before_commit = Model::from_status(Absent, Valid);
        for &step in &plan.steps()[..4] {
            before_commit.apply(step);
        }
        assert_eq!(before_commit.backup, Some(Value::Old));
        assert_eq!(before_commit.live, Some(Value::New));
    }

    #[test]
    fn retry_after_each_power_cut_survives_every_second_failure() {
        let initial = Model::from_status(CopyStatus::Valid, CopyStatus::Absent);
        let first = write_plan(CopyStatus::Valid, CopyStatus::Absent).unwrap();
        let mut interrupted = initial;
        let mut retry_failures = 0;
        for &first_step in first.steps() {
            interrupted.apply(first_step);
            let (live, backup) = interrupted.statuses();
            let retry = write_plan(live, backup).unwrap();
            for fail_at in 0..retry.steps().len() {
                let mut model = interrupted;
                for &step in &retry.steps()[..fail_at] {
                    model.apply(step);
                }
                model.fail(retry.steps()[fail_at]);
                assert!(
                    model.readable().is_some(),
                    "retry failure {fail_at} after {first_step:?}: {model:?}"
                );
                retry_failures += 1;
            }
        }
        assert!(retry_failures >= 30);
    }

    fn apply_delete(model: &mut Model, step: DeleteStep) {
        match step {
            DeleteStep::RemoveLive => model.live = None,
            DeleteStep::RemoveBackup => model.backup = None,
        }
    }

    #[test]
    fn delete_reports_each_failure_without_a_backup_resurrection() {
        use CopyStatus::*;
        let states = [Absent, Valid, Invalid];
        let mut scenarios = 0;
        for live in states {
            for backup in states {
                let initial = Model::from_status(live, backup);
                if initial.readable().is_none() {
                    continue;
                }
                scenarios += 1;
                let plan = delete_plan(live, backup).unwrap();
                for fail_at in 0..plan.len() {
                    let mut model = initial;
                    for &step in &plan[..fail_at] {
                        apply_delete(&mut model, step);
                    }
                    // Failed remove has no effect and is returned to JS.
                    assert!(
                        model.readable().is_some(),
                        "delete failure {fail_at} in {live:?}/{backup:?}: {model:?}"
                    );
                }
                let mut deleted = initial;
                for step in plan {
                    apply_delete(&mut deleted, step);
                }
                assert!(deleted.readable().is_none());
            }
        }
        assert_eq!(scenarios, 5);
        assert_eq!(
            delete_plan(Valid, Valid).unwrap()[0],
            DeleteStep::RemoveBackup
        );
        assert_eq!(
            delete_plan(Absent, Valid).unwrap()[0],
            DeleteStep::RemoveLive
        );
    }

    #[test]
    fn io_errors_abort_planning_before_any_mutation() {
        assert_eq!(write_plan(CopyStatus::IoError, CopyStatus::Valid), Err(()));
        assert_eq!(write_plan(CopyStatus::Valid, CopyStatus::IoError), Err(()));
        assert_eq!(delete_plan(CopyStatus::IoError, CopyStatus::Valid), Err(()));
        assert_eq!(delete_plan(CopyStatus::Valid, CopyStatus::IoError), Err(()));
    }
}
