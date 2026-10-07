//! Save bridge: bounded, atomic saves under `ms0:/PSP/COMMON/pocketjs/save/`.
//!
//! The guest calls the `__pspSave` FFI synchronously. Memstick I/O on the
//! main thread is the same trade-off pak_external.rs makes for asset reads:
//! a save is a rare, bounded operation (the guest menu refuses one past the
//! cap), and a synchronous contract lets the save menu report a failed write
//! immediately instead of queueing work whose failure it could not observe.
//!
//! Writes are atomic: the bytes land in `<name>.tmp` first, then a rename
//! swaps the live file. The previous live file is parked as `<name>.bak`
//! across the swap, so a crash between the two renames loses at most the
//! write in progress; [`read`] falls back to the `.bak` when the live file
//! is absent.
//!
//! The pure path validation and `sceIoOpen` error classification live in
//! `save_core.rs` (no `psp::sys` dependency) so their unit tests run on the
//! host; this module performs the memstick FFI.

use alloc::vec;
use alloc::vec::Vec;
use psp::sys::{self, IoOpenFlags, IoWhence, SceUid};

use crate::save_core::{classify_open, resolve, with_suffix, ENOENT, MAX_FILE_BYTES};

struct File(SceUid);
impl Drop for File {
    fn drop(&mut self) {
        unsafe {
            sys::sceIoClose(self.0);
        }
    }
}

/// Create the save directory chain (`ms0:/PSP/COMMON/pocketjs/save/`).
/// sceIoMkdir creates one level at a time and fails on an existing entry, so
/// every level is best-effort.
unsafe fn ensure_save_dir() {
    for dir in [
        b"ms0:/PSP/COMMON/pocketjs\0".as_slice(),
        b"ms0:/PSP/COMMON/pocketjs/save\0".as_slice(),
    ] {
        sys::sceIoMkdir(dir.as_ptr(), 0o777);
    }
}

/// Read a whole file. `Ok(None)` means absent (ENOENT); `Err(())` is an
/// I/O failure (any other open error, or a broken read).
unsafe fn read_file(path: *const u8) -> Result<Option<Vec<u8>>, ()> {
    let fd = match classify_open(sys::sceIoOpen(path, IoOpenFlags::RD_ONLY, 0).0) {
        Ok(Some(fd)) => SceUid(fd),
        Ok(None) => return Ok(None),
        Err(()) => return Err(()),
    };
    let f = File(fd);
    let len = sys::sceIoLseek32(fd, 0, IoWhence::End);
    if len < 0 {
        return Err(());
    }
    let len = len as usize;
    if len > MAX_FILE_BYTES {
        return Err(());
    }
    if sys::sceIoLseek32(fd, 0, IoWhence::Set) != 0 {
        return Err(());
    }
    let mut buf = vec![0u8; len];
    let mut done = 0;
    while done < len {
        let n = sys::sceIoRead(
            fd,
            buf.as_mut_ptr().add(done) as *mut _,
            (len - done).min(4096) as u32,
        );
        if n <= 0 {
            return Err(());
        }
        done += n as usize;
    }
    drop(f);
    Ok(Some(buf))
}

/// Write the whole buffer, one 4 KiB transfer at a time.
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

/// Read a save file as UTF-8 bytes. `Ok(None)` means absent (after the
/// `.bak` fallback); errors are static strings the FFI throws.
pub unsafe fn read(path: &str) -> Result<Option<Vec<u8>>, &'static str> {
    let (full, len) = resolve(path).ok_or("Invalid save path")?;
    match read_file(full.as_ptr()) {
        Ok(Some(bytes)) => Ok(Some(bytes)),
        Ok(None) => {
            // A crash between the two renames of a write can leave the
            // backup as the only copy.
            let bak = with_suffix(&full, len, b".bak");
            read_file(bak.as_ptr()).map_err(|_| "Save could not be read")
        }
        Err(()) => Err("Save could not be read"),
    }
}

/// Atomically replace a save file. The bytes land in `<name>.tmp`; the
/// previous live file (if any) is parked as `<name>.bak` while the tmp is
/// renamed over it, then the backup is removed.
pub unsafe fn write(path: &str, data: &[u8]) -> Result<(), &'static str> {
    let (full, len) = resolve(path).ok_or("Invalid save path")?;
    if data.len() > MAX_FILE_BYTES {
        return Err("Save is larger than 1 MiB");
    }
    // The save directory is created once per write; EEXIST is expected.
    ensure_save_dir();

    let tmp = with_suffix(&full, len, b".tmp");
    {
        let fd = sys::sceIoOpen(
            tmp.as_ptr(),
            IoOpenFlags::WR_ONLY | IoOpenFlags::CREAT | IoOpenFlags::TRUNC,
            0o777,
        );
        if fd.0 < 0 {
            // A read-only memory stick or a full one refuses the create.
            return Err("Memory stick could not be written");
        }
        let f = File(fd);
        if !write_all(fd, data) {
            return Err("Memory stick write failed");
        }
        drop(f); // close before rename
    }

    let bak = with_suffix(&full, len, b".bak");
    // A stale backup from a crashed earlier write is discarded.
    sys::sceIoRemove(bak.as_ptr());
    // Park the live file, then swap. sceIoRename refuses an existing
    // destination on PSP firmware, so the backup has to move first. A
    // non-ENOENT open failure is a real I/O error: surface it instead of
    // treating the live file as absent and renaming over it.
    let had_live = match classify_open(sys::sceIoOpen(full.as_ptr(), IoOpenFlags::RD_ONLY, 0).0) {
        Ok(Some(fd)) => {
            sys::sceIoClose(SceUid(fd));
            true
        }
        Ok(None) => false,
        Err(()) => {
            sys::sceIoRemove(tmp.as_ptr());
            return Err("Save could not be read");
        }
    };
    if had_live {
        if sys::sceIoRename(full.as_ptr(), bak.as_ptr()) < 0 {
            sys::sceIoRemove(tmp.as_ptr());
            return Err("Save could not be replaced");
        }
    }
    if sys::sceIoRename(tmp.as_ptr(), full.as_ptr()) < 0 {
        // Put the parked file back so the failed swap costs nothing.
        if had_live {
            let _ = sys::sceIoRename(bak.as_ptr(), full.as_ptr());
        }
        return Err("Save could not be replaced");
    }
    if had_live {
        sys::sceIoRemove(bak.as_ptr());
    }
    Ok(())
}

/// Remove a save file. Absent is success (idempotent, like the fs module's
/// `rmSync(..., { force: true })`).
pub unsafe fn remove(path: &str) -> Result<(), &'static str> {
    let (full, len) = resolve(path).ok_or("Invalid save path")?;
    let r = sys::sceIoRemove(full.as_ptr());
    if r < 0 && (r as u32) != ENOENT {
        return Err("Save could not be removed");
    }
    let bak = with_suffix(&full, len, b".bak");
    let _ = sys::sceIoRemove(bak.as_ptr());
    Ok(())
}
