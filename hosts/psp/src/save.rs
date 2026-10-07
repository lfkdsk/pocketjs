//! Crash-safe save bridge under `ms0:/PSP/COMMON/pocketjs/save/`.
//!
//! The guest calls the `__pspSave` FFI synchronously. Each new physical file
//! has a fixed length/checksum header. Reads validate live first and fall back
//! to a validated `.bak`; pre-header JSON saves remain readable for migration.
//!
//! Replacement follows the pure plan in `save_core.rs`: write `.tmp`, flush it,
//! validate it, then rotate a valid live copy to `.bak` or preserve `.bak` when
//! it is the only valid old generation. Only then does `.tmp` become live. The
//! previous generation stays in `.bak`, so a later corrupt live file remains
//! recoverable. Every mutation order is fault-injected by host-native tests.

use alloc::vec;
use alloc::vec::Vec;
use psp::sys::{self, IoOpenFlags, IoWhence, SceUid};

use crate::save_core::{
    classify_open, delete_plan, record_header, record_span, resolve, select_read, with_suffix,
    CopyStatus, DeleteStep, ReadSource, WriteStep, ENOENT, MAX_STORED_BYTES,
};

struct File(Option<SceUid>);

impl File {
    fn new(fd: SceUid) -> Self {
        Self(Some(fd))
    }

    fn fd(&self) -> SceUid {
        self.0.expect("open PSP save file")
    }

    unsafe fn close(mut self) -> bool {
        let fd = self.0.take().expect("open PSP save file");
        sys::sceIoClose(fd) >= 0
    }
}

impl Drop for File {
    fn drop(&mut self) {
        if let Some(fd) = self.0.take() {
            unsafe {
                sys::sceIoClose(fd);
            }
        }
    }
}

/// Create the save directory chain (`ms0:/PSP/COMMON/pocketjs/save/`).
/// sceIoMkdir creates one level at a time and fails on an existing entry, so
/// every level is best-effort; the following open reports a real failure.
unsafe fn ensure_save_dir() {
    for dir in [
        b"ms0:/PSP/COMMON/pocketjs\0".as_slice(),
        b"ms0:/PSP/COMMON/pocketjs/save\0".as_slice(),
    ] {
        sys::sceIoMkdir(dir.as_ptr(), 0o777);
    }
}

/// Read a whole physical file. `Ok(None)` means ENOENT; any other open, seek,
/// read, close, or size failure is `Err(())`.
unsafe fn read_file(path: *const u8) -> Result<Option<Vec<u8>>, ()> {
    let fd = match classify_open(sys::sceIoOpen(path, IoOpenFlags::RD_ONLY, 0).0) {
        Ok(Some(fd)) => SceUid(fd),
        Ok(None) => return Ok(None),
        Err(()) => return Err(()),
    };
    let file = File::new(fd);
    let len = sys::sceIoLseek32(file.fd(), 0, IoWhence::End);
    if len < 0 {
        return Err(());
    }
    let len = len as usize;
    if len > MAX_STORED_BYTES {
        return Err(());
    }
    if sys::sceIoLseek32(file.fd(), 0, IoWhence::Set) != 0 {
        return Err(());
    }
    let mut buf = vec![0u8; len];
    let mut done = 0;
    while done < len {
        let n = sys::sceIoRead(
            file.fd(),
            buf.as_mut_ptr().add(done) as *mut _,
            (len - done).min(4096) as u32,
        );
        if n <= 0 {
            return Err(());
        }
        done += n as usize;
    }
    if !file.close() {
        return Err(());
    }
    Ok(Some(buf))
}

enum LoadedCopy {
    Absent,
    Valid(Vec<u8>),
    Invalid,
    IoError,
}

impl LoadedCopy {
    fn status(&self) -> CopyStatus {
        match self {
            Self::Absent => CopyStatus::Absent,
            Self::Valid(_) => CopyStatus::Valid,
            Self::Invalid => CopyStatus::Invalid,
            Self::IoError => CopyStatus::IoError,
        }
    }
}

/// Load, checksum, and unwrap one physical copy. Framed and legacy saves must
/// both contain UTF-8 because the FFI returns a JavaScript string.
unsafe fn load_copy(path: *const u8) -> LoadedCopy {
    match read_file(path) {
        Ok(None) => LoadedCopy::Absent,
        Err(()) => LoadedCopy::IoError,
        Ok(Some(mut bytes)) => {
            let (offset, len) = match record_span(&bytes) {
                Ok(span) => span,
                Err(()) => return LoadedCopy::Invalid,
            };
            if core::str::from_utf8(&bytes[offset..offset + len]).is_err() {
                return LoadedCopy::Invalid;
            }
            if offset != 0 {
                bytes.copy_within(offset..offset + len, 0);
                bytes.truncate(len);
            }
            LoadedCopy::Valid(bytes)
        }
    }
}

/// Write a whole buffer, one 4 KiB transfer at a time.
unsafe fn write_all(fd: SceUid, data: &[u8]) -> bool {
    let mut done = 0;
    while done < data.len() {
        let n = sys::sceIoWrite(
            fd,
            data.as_ptr().add(done) as *mut _,
            (data.len() - done).min(4096),
        );
        if n <= 0 {
            return false;
        }
        done += n as usize;
    }
    true
}

unsafe fn write_temp(path: *const u8, header: &[u8], data: &[u8]) -> bool {
    let fd = sys::sceIoOpen(
        path,
        IoOpenFlags::WR_ONLY | IoOpenFlags::CREAT | IoOpenFlags::TRUNC,
        0o777,
    );
    if fd.0 < 0 {
        return false;
    }
    let file = File::new(fd);
    if !write_all(file.fd(), header) || !write_all(file.fd(), data) {
        return false;
    }
    file.close()
}

unsafe fn sync_memory_stick() -> bool {
    sys::sceIoSync(b"ms0:\0".as_ptr(), 0) >= 0
}

unsafe fn remove_file(path: *const u8) -> bool {
    let result = sys::sceIoRemove(path);
    result >= 0 || (result as u32) == ENOENT
}

/// Read a save as guest UTF-8 bytes. A valid live record wins; invalid,
/// unreadable, or absent live falls back to a valid backup. Only two absent
/// copies mean an empty slot. Every other no-valid-copy state is corruption.
pub unsafe fn read(path: &str) -> Result<Option<Vec<u8>>, &'static str> {
    let (full, len) = resolve(path).ok_or("Invalid save path")?;
    let live = load_copy(full.as_ptr());
    if let LoadedCopy::Valid(bytes) = live {
        return Ok(Some(bytes));
    }
    let live_status = live.status();
    let bak = with_suffix(&full, len, b".bak");
    let backup = load_copy(bak.as_ptr());
    match select_read(live_status, backup.status()) {
        Ok(Some(ReadSource::Backup)) => match backup {
            LoadedCopy::Valid(bytes) => Ok(Some(bytes)),
            _ => unreachable!("read selector chose a non-valid backup"),
        },
        Ok(Some(ReadSource::Live)) => unreachable!("valid live returned before fallback"),
        Ok(None) => Ok(None),
        Err(()) => Err("Save is damaged or could not be read"),
    }
}

/// Replace one logical save according to the pure crash-safe plan. All old
/// copy probing happens before the temp write; an I/O error aborts without a
/// mutation. A best-effort temp cleanup after failure never touches live/bak.
pub unsafe fn write(path: &str, data: &[u8]) -> Result<(), &'static str> {
    let (full, len) = resolve(path).ok_or("Invalid save path")?;
    let header = record_header(data).ok_or("Save is larger than 1 MiB")?;
    ensure_save_dir();

    let tmp = with_suffix(&full, len, b".tmp");
    let bak = with_suffix(&full, len, b".bak");
    let live_status = load_copy(full.as_ptr()).status();
    let backup_status = load_copy(bak.as_ptr()).status();
    let plan = crate::save_core::write_plan(live_status, backup_status)
        .map_err(|_| "Save copies could not be inspected")?;

    for &step in plan.steps() {
        let result = match step {
            WriteStep::WriteTemp => write_temp(tmp.as_ptr(), &header, data),
            WriteStep::SyncTemp | WriteStep::SyncCommitted => sync_memory_stick(),
            WriteStep::ValidateTemp => load_copy(tmp.as_ptr()).status() == CopyStatus::Valid,
            WriteStep::RemoveBackup => remove_file(bak.as_ptr()),
            WriteStep::MoveLiveToBackup => sys::sceIoRename(full.as_ptr(), bak.as_ptr()) >= 0,
            WriteStep::RemoveInvalidLive => remove_file(full.as_ptr()),
            WriteStep::MoveTempToLive => sys::sceIoRename(tmp.as_ptr(), full.as_ptr()) >= 0,
        };
        if !result {
            // If temp already became live this is ENOENT; otherwise cleanup is
            // safe because the plan preserved a validated old live/backup.
            let _ = remove_file(tmp.as_ptr());
            return Err(match step {
                WriteStep::WriteTemp => "Memory stick write failed",
                WriteStep::SyncTemp | WriteStep::SyncCommitted => {
                    "Memory stick could not be synchronized"
                }
                WriteStep::ValidateTemp => "Memory stick write was incomplete",
                WriteStep::RemoveBackup
                | WriteStep::MoveLiveToBackup
                | WriteStep::RemoveInvalidLive
                | WriteStep::MoveTempToLive => "Save could not be replaced",
            });
        }
    }
    Ok(())
}

/// Remove both physical generations. The pure plan chooses the order from
/// their validated states, and every non-ENOENT failure is returned. Therefore
/// success cannot leave a backup that later reappears as the logical save.
pub unsafe fn remove(path: &str) -> Result<(), &'static str> {
    let (full, len) = resolve(path).ok_or("Invalid save path")?;
    let bak = with_suffix(&full, len, b".bak");
    let live_status = load_copy(full.as_ptr()).status();
    let backup_status = load_copy(bak.as_ptr()).status();
    let plan = delete_plan(live_status, backup_status)
        .map_err(|_| "Save copies could not be inspected")?;
    for step in plan {
        let ok = match step {
            DeleteStep::RemoveLive => remove_file(full.as_ptr()),
            DeleteStep::RemoveBackup => remove_file(bak.as_ptr()),
        };
        if !ok {
            return Err("Save could not be removed");
        }
    }
    Ok(())
}
