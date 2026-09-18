//! Transfer fine donor texture while retaining the destination's broad colour and light.
use image::{ImageBuffer, Rgb, Rgb32FImage, RgbImage};

pub(super) fn transfer_texture(
    source: &RgbImage,
    bounds: (u32, u32, u32, u32),
    offset: (i32, i32),
    radius: f32,
    tile_size: Option<u32>,
) -> RgbImage {
    let (x0, y0, width, height) = bounds;
    let pad = (radius * 3.0).ceil() as u32 + 1;
    let sample = |dx: i32, dy: i32| -> Rgb32FImage {
        ImageBuffer::from_fn(width + 2 * pad, height + 2 * pad, |x, y| {
            let sx = (i64::from(x0) + i64::from(x) - i64::from(pad) + i64::from(dx))
                .clamp(0, i64::from(source.width()) - 1) as u32;
            let sy = (i64::from(y0) + i64::from(y) - i64::from(pad) + i64::from(dy))
                .clamp(0, i64::from(source.height()) - 1) as u32;
            Rgb(source.get_pixel(sx, sy).0.map(f32::from))
        })
    };
    let destination_low = image::imageops::blur(&sample(0, 0), radius);
    let donor = if let Some(size) = tile_size {
        let cx = i64::from(x0) + i64::from(width - 1) / 2 + i64::from(offset.0);
        let cy = i64::from(y0) + i64::from(height - 1) / 2 + i64::from(offset.1);
        ImageBuffer::from_fn(size + 2 * pad, size + 2 * pad, |x, y| {
            let sx = (cx - i64::from(size / 2) + i64::from(x) - i64::from(pad))
                .clamp(0, i64::from(source.width()) - 1) as u32;
            let sy = (cy - i64::from(size / 2) + i64::from(y) - i64::from(pad))
                .clamp(0, i64::from(source.height()) - 1) as u32;
            Rgb(source.get_pixel(sx, sy).0.map(f32::from))
        })
    } else {
        sample(offset.0, offset.1)
    };
    let donor_low = image::imageops::blur(&donor, radius);
    ImageBuffer::from_fn(width, height, |x, y| {
        let destination = destination_low.get_pixel(x + pad, y + pad);
        // Reflect only the extracted detail. Filtering the repeated colour tile
        // would turn a broad donor gradient into artificial grid edges.
        let reflect = |position: u32, size: u32| {
            let index = position % (2 * size);
            if index < size {
                index
            } else {
                2 * size - 1 - index
            }
        };
        let (dx, dy) = tile_size.map_or((x, y), |size| (reflect(x, size), reflect(y, size)));
        let detail = donor.get_pixel(dx + pad, dy + pad);
        let low = donor_low.get_pixel(dx + pad, dy + pad);
        Rgb(std::array::from_fn(|channel| {
            (destination[channel] + detail[channel] - low[channel])
                .round()
                .clamp(0.0, 255.0) as u8
        }))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_destination_colour_and_transfers_donor_detail() {
        let source = ImageBuffer::from_fn(256, 128, |x, y| {
            if x < 128 {
                Rgb([50, 80, 110])
            } else {
                let noise = if (x + y) % 2 == 0 { 6 } else { -6 };
                Rgb([150i16, 160, 180].map(|v| (v + noise) as u8))
            }
        });
        let output = transfer_texture(&source, (32, 32, 64, 64), (128, 0), 8.0, None);
        for (x, y, pixel) in output.enumerate_pixels() {
            let noise = if (x + y) % 2 == 0 { 6 } else { -6 };
            for (channel, base) in [50i16, 80, 110].into_iter().enumerate() {
                assert!((i16::from(pixel[channel]) - base - noise).abs() <= 1);
            }
        }
    }

    #[test]
    fn zero_offset_preserves_pixels_including_image_edges() {
        let source = ImageBuffer::from_fn(40, 30, |x, y| {
            Rgb([(x * 5) as u8, (y * 7) as u8, ((x + y) * 3) as u8])
        });
        assert_eq!(
            transfer_texture(&source, (0, 0, 40, 30), (0, 0), 8.0, None),
            source
        );
    }

    #[test]
    fn repeated_detail_does_not_repeat_donor_gradient() {
        let source = ImageBuffer::from_fn(640, 256, |x, y| {
            let value = if x < 256 { 60 } else { 90 + x / 8 };
            let noise = if x >= 256 && (x + y) % 2 == 0 { 5 } else { 0 };
            Rgb([(value + noise) as u8; 3])
        });
        let output = transfer_texture(&source, (32, 32, 192, 192), (320, 0), 8.0, Some(64));
        for pixel in output.pixels() {
            assert!(
                (56..=64).contains(&pixel[0]),
                "donor colour or tile seam leaked"
            );
        }
        assert!(output.pixels().any(|pixel| pixel[0] < 59));
        assert!(output.pixels().any(|pixel| pixel[0] > 61));
    }
}
