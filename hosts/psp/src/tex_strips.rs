//! Cache-line sprite columns for exact integer nearest-neighbour scaling.
//! Fractional, mirrored and non-integral UV mappings retain one sprite.
pub fn strip_count(texels: (f32, f32, f32, f32), w: i32, h: i32, strip: i32) -> usize {
    let (u0, v0, u1, v1) = texels;
    let whole = |t: f32| t.is_finite() && (0.0..=32767.0).contains(&t) && t == (t as i32) as f32;
    if strip <= 0 || w <= 0 || h <= 0 || u0 < 0.0
        || !(whole(u0) && whole(u1) && whole(v0) && whole(v1)) { return 1; }
    let (a, b) = (u0 as i32, u1 as i32);
    let du = b - a;
    let dv = v1 as i32 - v0 as i32;
    if du <= strip || dv <= 0 || w < du || h < dv || w % du != 0 || h % dv != 0 { return 1; }
    ((b + strip - 1) / strip - a / strip) as usize
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn integer_scaled_columns_preserve_every_nearest_neighbour_sample() {
        for scale in [1, 2, 3, 4] {
            for start in [0, 5, 63, 64] {
                for width in [65, 127, 240, 480] {
                    let end = start + width;
                    let count = strip_count((start as f32, 0.0, end as f32, 160.0), width * scale, 160 * scale, 64);
                    let mut covered = vec![None; (width * scale) as usize];
                    let mut a = start;
                    let mut actual_count = 0;
                    while a < end {
                        let b = ((a / 64 + 1) * 64).min(end);
                        assert!(b - a <= 64);
                        let x0 = (a - start) * scale;
                        let x1 = (b - start) * scale;
                        for x in x0..x1 {
                            assert!(covered[x as usize].is_none(), "overlapping columns");
                            covered[x as usize] = Some(a + (x - x0) / scale);
                        }
                        a = b;
                        actual_count += 1;
                    }
                    assert_eq!(count, actual_count);
                    for (x, sample) in covered.into_iter().enumerate() {
                        assert_eq!(sample, Some(start + x as i32 / scale));
                    }
                }
            }
        }
    }
    #[test]
    fn fractional_mirrored_and_downscaled_mappings_are_unsplit() {
        assert_eq!(strip_count((0.5, 0.0, 240.5, 160.0), 480, 320, 64), 1);
        assert_eq!(strip_count((240.0, 0.0, 0.0, 160.0), 480, 320, 64), 1);
        assert_eq!(strip_count((0.0, 0.0, 240.0, 160.0), 360, 240, 64), 1);
        assert_eq!(strip_count((0.0, 0.0, 240.0, 160.0), 120, 80, 64), 1);
        assert_eq!(strip_count((0.0, 0.0, 64.0, 32.0), 128, 64, 64), 1);
    }
}
