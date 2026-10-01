//! File-backed PAK blobs. Only the validated directory is embedded; payloads
//! are read on demand from assets.pak beside the executable or on host0:.
use alloc::vec;
use alloc::vec::Vec;
use core::ffi::c_void;
use psp::sys::{self, IoOpenFlags, IoWhence, SceUid};
use pocketjs_core::spec;

static mut INDEX: &[u8] = &[];
static mut FILE: SceUid = SceUid(-1);
static mut FILE_LEN: usize = 0;
fn u32_at(b: &[u8], off: usize) -> Option<usize> {
    Some(u32::from_le_bytes(b.get(off..off + 4)?.try_into().ok()?) as usize)
}
fn u16_at(b: &[u8], off: usize) -> Option<usize> {
    Some(u16::from_le_bytes(b.get(off..off + 2)?.try_into().ok()?) as usize)
}
/// Single guest thread; replacing a package closes its previous file.
pub unsafe fn install(index: &'static [u8]) {
    if FILE.0 >= 0 { sys::sceIoClose(FILE); }
    INDEX = &[];
    FILE = SceUid(-1);
    if index.len() < spec::pak::HEADER_SIZE
        || u32_at(index, 0) != Some(spec::pak::MAGIC as usize)
        || u16_at(index, 4) != Some(spec::pak::VERSION as usize)
    { return; }
    for path in [b"assets.pak\0".as_slice(), b"host0:/assets.pak\0".as_slice()] {
        let fd = sys::sceIoOpen(path.as_ptr(), IoOpenFlags::RD_ONLY, 0);
        if fd.0 < 0 { continue; }
        let len = sys::sceIoLseek(fd, 0, IoWhence::End);
        if len > 0 && Some(len as usize) == u32_at(index, 24) {
            // Verify the entire index against the staged file before use.
            let mut actual = vec![0u8; index.len()];
            FILE = fd;
            FILE_LEN = len as usize;
            if read_at(0, &mut actual) && actual == index { INDEX = index; return; }
            FILE = SceUid(-1);
        }
        sys::sceIoClose(fd);
    }
    psp::dprintln!("[PocketJS pak] assets.pak missing or index mismatch");
}
pub unsafe fn enabled() -> bool { !INDEX.is_empty() }
unsafe fn read_at(off: usize, bytes: &mut [u8]) -> bool {
    if FILE.0 < 0 || off.checked_add(bytes.len()).map_or(true, |end| end > FILE_LEN) { return false; }
    if sys::sceIoLseek(FILE, off as i64, IoWhence::Set) != off as i64 { return false; }
    let mut n = 0;
    while n < bytes.len() {
        let got = sys::sceIoRead(FILE, bytes[n..].as_mut_ptr() as *mut c_void, (bytes.len() - n) as u32);
        if got <= 0 { return false; }
        n += got as usize;
    }
    true
}
/// The producer sorts names. Binary search avoids scanning thousands of keys
/// on each chunk or JSON load; comparisons require no allocations.
fn locate(b: &[u8], key: &str) -> Option<(usize, usize)> {
    let count = u32_at(b, 8)?;
    let dir = u32_at(b, 12)?;
    let names = u32_at(b, 16)?;
    let mut lo = 0;
    let mut hi = count;
    while lo < hi {
        let mid = lo + (hi - lo) / 2;
        let e = dir.checked_add(mid.checked_mul(spec::pak::ENTRY_SIZE)?)?;
        let name_off = names.checked_add(u32_at(b, e + 12)?)?;
        let name_len = u16::from_le_bytes(b.get(e + 16..e + 18)?.try_into().ok()?) as usize;
        let name = b.get(name_off..name_off.checked_add(name_len)?)?;
        match name.cmp(key.as_bytes()) {
            core::cmp::Ordering::Less => lo = mid + 1,
            core::cmp::Ordering::Greater => hi = mid,
            core::cmp::Ordering::Equal => {
                let off = u32_at(b, e + 4)?;
                let len = u32_at(b, e + 8)?;
                return Some((off, len));
            }
        }
    }
    None
}

const MAX_READ: usize = 4 * 1024 * 1024;

/// Read one bounded interval without allocating the rest of the entry.
pub unsafe fn read_range(key: &str, start: usize, end: usize) -> Option<Vec<u8>> {
    let (off, len) = locate(INDEX, key)?;
    if start > end || end > len || end - start > MAX_READ { return None; }
    let mut bytes = vec![0u8; end - start];
    if read_at(off.checked_add(start)?, &mut bytes) { Some(bytes) } else { None }
}

pub unsafe fn read(key: &str) -> Option<Vec<u8>> {
    let (_, len) = locate(INDEX, key)?;
    read_range(key, 0, len)
}
