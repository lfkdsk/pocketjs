//! When the PSP frame loop forces a QuickJS collection, and which kind.
//!
//! QuickJS's own trigger never fires on this host (the arena-backed malloc
//! hooks leave its `malloc_size` at zero), so the frame loop decides. Pure
//! state so the rule can be tested on the build machine; `main.rs` owns one
//! `GcTrigger` and one `GcKind` per QuickJS runtime.
//!
//! - While the arena still has a bump tail, the bump is the signal: collect
//!   when it has advanced more than `GC_STEP` since the last collection.
//!   Steady-state guests recycle free-list blocks and never trigger it.
//! - Once the tail is spent the bump stops moving, so garbage cycles would
//!   drain the free lists until an allocation fails. QuickJS live request
//!   bytes take over: collect when they have grown `GC_STEP` above their
//!   low-water mark since the last collection.
//!
//! A full `JS_RunGC` walks every live object, so its pause grows with the
//! heap (~150 ms for a 25 MB guest under PPSSPP). Collections are therefore
//! generational (`GcKind`): the first one only marks everything old (the
//! loaded program and its data), later ones are minor collections over the
//! objects allocated since the previous one, and a full collection runs only
//! when the live heap nears the arena (`FULL_LIVE_NUM`/`FULL_LIVE_DEN`).
//! QuickJS also runs a minor collection by itself once `YOUNG_LIMIT` young
//! objects exist, and objects a collection queued for release are freed
//! `FREE_BUDGET` at a time per frame.

/// Growth (bytes) that triggers a collection, for both signals.
pub const GC_STEP: usize = 256 * 1024;

/// Young objects at which QuickJS runs a minor collection mid-frame, so an
/// allocation burst (a map load) cannot build one long collection.
pub const YOUNG_LIMIT: u32 = 8_000;

/// Objects released per frame from the queue a minor collection leaves.
pub const FREE_BUDGET: i32 = 1_000;

/// A full collection becomes due once live bytes exceed this fraction of the
/// arena capacity and the tail is spent...
pub const FULL_LIVE_NUM: usize = 5;
pub const FULL_LIVE_DEN: usize = 8;
/// ...and live bytes have grown this much since the previous full one.
pub const FULL_STEP: usize = 2 * 1024 * 1024;

/// The collection to run when [`GcTrigger::frame_end`] asks for one.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Collection {
    /// Mark every object old without collecting (`JS_PromoteGCObjects`).
    Promote,
    /// Collect cycles among young objects only (`JS_RunGCMinor`).
    Minor,
    /// Walk the whole heap, old objects included (`JS_RunGC`).
    Full,
}

/// Chooses the collection kind for one QuickJS runtime.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct GcKind {
    promoted: bool,
    full_live: usize,
}

impl GcKind {
    pub const fn new() -> Self {
        Self { promoted: false, full_live: 0 }
    }

    /// The kind for a collection the trigger asked for. `capacity` is the
    /// arena capacity in bytes.
    pub fn choose(&mut self, now: Sample, capacity: usize) -> Collection {
        if !self.promoted {
            self.promoted = true;
            return Collection::Promote;
        }
        let near_full = now.live > capacity / FULL_LIVE_DEN * FULL_LIVE_NUM;
        if now.tail_free < GC_STEP && near_full && now.live > self.full_live.saturating_add(FULL_STEP) {
            return Collection::Full;
        }
        Collection::Minor
    }

    /// Record live bytes right after a full collection.
    pub fn full_done(&mut self, live: usize) {
        self.full_live = live;
    }
}

/// Allocator readings at the end of a frame.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Sample {
    /// Arena bump high-water (`arena::Stats::bump_bytes`).
    pub bump: usize,
    /// Arena bytes left above the bump (`arena::Stats::tail_free_bytes`).
    pub tail_free: usize,
    /// QuickJS live request bytes (`qjs_alloc::Stats::live_requested`).
    pub live: usize,
}

/// Baselines for one QuickJS runtime. Create it with the runtime: a guest
/// switch frees the old runtime, so its baselines mean nothing to the next.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct GcTrigger {
    last_bump: usize,
    live_low: usize,
}

impl GcTrigger {
    /// Baselines from the readings when the runtime is created.
    pub const fn new(at: Sample) -> Self {
        Self { last_bump: at.bump, live_low: at.live }
    }

    /// Whether to collect after this frame. When it returns true, run the
    /// collection and then call [`GcTrigger::collected`]. Otherwise the live
    /// baseline follows live bytes down, so growth is measured from the
    /// lowest point since the last collection.
    pub fn frame_end(&mut self, now: Sample) -> bool {
        if now.bump > self.last_bump.saturating_add(GC_STEP) {
            return true;
        }
        if now.tail_free < GC_STEP && now.live > self.live_low.saturating_add(GC_STEP) {
            return true;
        }
        if now.live < self.live_low {
            self.live_low = now.live;
        }
        false
    }

    /// Reset both baselines to the readings right after a collection.
    pub fn collected(&mut self, after: Sample) {
        self.last_bump = after.bump;
        self.live_low = after.live;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const KIB: usize = 1024;
    const MIB: usize = 1024 * KIB;

    fn s(bump: usize, tail_free: usize, live: usize) -> Sample {
        Sample { bump, tail_free, live }
    }

    #[test]
    fn bump_with_tail_left_ignores_live() {
        let mut gc = GcTrigger::new(s(10 * MIB, 8 * MIB, 5 * MIB));
        // Live bytes balloon but the bump has tail and has not moved a step.
        assert!(!gc.frame_end(s(10 * MIB + GC_STEP, 8 * MIB - GC_STEP, 20 * MIB)));
        // One byte past the step on the bump collects.
        assert!(gc.frame_end(s(10 * MIB + GC_STEP + 1, 8 * MIB - GC_STEP - 1, 5 * MIB)));
        gc.collected(s(10 * MIB + GC_STEP + 1, 8 * MIB - GC_STEP - 1, 5 * MIB));
        assert!(!gc.frame_end(s(10 * MIB + 2 * GC_STEP, 8 * MIB - 2 * GC_STEP, 30 * MIB)));
    }

    #[test]
    fn spent_tail_collects_on_live_growth() {
        let end = 46 * MIB;
        let mut gc = GcTrigger::new(s(end - 4 * KIB, 4 * KIB, 26 * MIB));
        // The bump can no longer grow; live growth of exactly one step waits.
        assert!(!gc.frame_end(s(end - 4 * KIB, 4 * KIB, 26 * MIB + GC_STEP)));
        assert!(gc.frame_end(s(end - 4 * KIB, 4 * KIB, 26 * MIB + GC_STEP + 1)));
        gc.collected(s(end - 4 * KIB, 4 * KIB, 25 * MIB));
        // Measured from the post-collection live bytes, not the old peak.
        assert!(!gc.frame_end(s(end - 4 * KIB, 4 * KIB, 25 * MIB + GC_STEP)));
        assert!(gc.frame_end(s(end - 4 * KIB, 4 * KIB, 25 * MIB + GC_STEP + 1)));
    }

    #[test]
    fn tail_just_under_a_step_counts_as_spent() {
        let mut gc = GcTrigger::new(s(40 * MIB, GC_STEP, 10 * MIB));
        assert!(!gc.frame_end(s(40 * MIB, GC_STEP, 12 * MIB)));
        assert!(gc.frame_end(s(40 * MIB, GC_STEP - 1, 12 * MIB)));
    }

    #[test]
    fn live_baseline_follows_a_fall() {
        let mut gc = GcTrigger::new(s(45 * MIB, 0, 26 * MIB));
        // Live falls by 6 MiB without a collection (frees, not cycles).
        assert!(!gc.frame_end(s(45 * MIB, 0, 23 * MIB)));
        assert!(!gc.frame_end(s(45 * MIB, 0, 20 * MIB)));
        // A step above the 20 MiB low-water collects, far below the old 26 MiB.
        assert!(!gc.frame_end(s(45 * MIB, 0, 20 * MIB + GC_STEP)));
        assert!(gc.frame_end(s(45 * MIB, 0, 20 * MIB + GC_STEP + 1)));
        // A rise that falls back without a collection does not raise the mark.
        let mut gc = GcTrigger::new(s(45 * MIB, 0, 20 * MIB));
        assert!(!gc.frame_end(s(45 * MIB, 0, 20 * MIB + 100 * KIB)));
        assert!(!gc.frame_end(s(45 * MIB, 0, 20 * MIB + 50 * KIB)));
        assert!(gc.frame_end(s(45 * MIB, 0, 20 * MIB + GC_STEP + 1)));
    }

    #[test]
    fn a_new_runtime_starts_from_its_own_readings() {
        // Guest A ends with a 26 MiB working set on a spent tail.
        let mut a = GcTrigger::new(s(MIB, 44 * MIB, 0));
        assert!(a.frame_end(s(45 * MIB, 0, 26 * MIB)));
        a.collected(s(45 * MIB, 0, 26 * MIB));
        // Teardown returns A's blocks to the free lists; the bump stays at the
        // arena end. Guest B gets a fresh trigger when its runtime is created.
        let mut b = GcTrigger::new(s(45 * MIB, 0, 0));
        // B's bundle evaluation reaches 20 MiB: collect at its first frame.
        // A's baseline (26 MiB) would not, so B's garbage would wait 6 MiB.
        assert!(!a.frame_end(s(45 * MIB, 0, 20 * MIB)));
        assert!(b.frame_end(s(45 * MIB, 0, 20 * MIB)));
        b.collected(s(45 * MIB, 0, 20 * MIB));
        // Then one step plus a byte of cycles collects again.
        assert!(!b.frame_end(s(45 * MIB, 0, 20 * MIB + GC_STEP)));
        assert!(b.frame_end(s(45 * MIB, 0, 20 * MIB + GC_STEP + 1)));
    }

    #[test]
    fn the_first_collection_only_promotes() {
        let mut kind = GcKind::new();
        let cap = 46 * MIB;
        assert_eq!(kind.choose(s(30 * MIB, 16 * MIB, 12 * MIB), cap), Collection::Promote);
        assert_eq!(kind.choose(s(30 * MIB, 16 * MIB, 12 * MIB), cap), Collection::Minor);
    }

    #[test]
    fn a_full_collection_needs_a_spent_tail_and_a_live_heap_near_the_arena() {
        let cap = 48 * MIB; // 5/8 = 30 MiB
        let mut kind = GcKind::new();
        kind.choose(s(20 * MIB, 28 * MIB, 12 * MIB), cap);
        // Tail left: minor even far above the threshold.
        assert_eq!(kind.choose(s(40 * MIB, 8 * MIB, 32 * MIB), cap), Collection::Minor);
        // Spent tail, live at the threshold: still minor.
        assert_eq!(kind.choose(s(48 * MIB, 4 * KIB, 30 * MIB), cap), Collection::Minor);
        // Spent tail, live past it: full.
        assert_eq!(kind.choose(s(48 * MIB, 4 * KIB, 30 * MIB + 1), cap), Collection::Full);
        kind.full_done(29 * MIB);
        // The next full one waits for FULL_STEP of growth past the last.
        assert_eq!(kind.choose(s(48 * MIB, 4 * KIB, 31 * MIB), cap), Collection::Minor);
        assert_eq!(kind.choose(s(48 * MIB, 4 * KIB, 31 * MIB + 1), cap), Collection::Full);
    }

    #[test]
    fn small_guest_on_a_fresh_runtime_collects_after_one_step() {
        // B boots on a spent tail: growth from its creation reading counts.
        let mut b = GcTrigger::new(s(45 * MIB, 0, 64 * KIB));
        assert!(!b.frame_end(s(45 * MIB, 0, 64 * KIB + GC_STEP)));
        assert!(b.frame_end(s(45 * MIB, 0, 64 * KIB + GC_STEP + 1)));
    }
}
