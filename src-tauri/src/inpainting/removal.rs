//! Native removal coverage, outward blending and final protection constraints.
use image::{GrayImage, Luma};
use imageproc::distance_transform::euclidean_squared_distance_transform;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemovalOptions {
    #[serde(default)]
    pub expand_pixels: u32,
    #[serde(default)]
    pub feather_pixels: u32,
}

impl RemovalOptions {
    pub fn validate(&self) -> Result<(), String> {
        if self.expand_pixels > 256 || self.feather_pixels > 256 {
            return Err("Removal expansion and feather must each be 0..256 source pixels".into());
        }
        Ok(())
    }

    pub fn enabled(&self) -> bool {
        self.expand_pixels != 0 || self.feather_pixels != 0
    }
}

/// The >=128 selection forms a fully replaced core. Existing weaker alpha is
/// retained wherever it exceeds the outward transition. Constraints are applied
/// last, so expansion cannot refill a protected hole or cross an intersection.
pub fn effective_mask(
    selection: &GrayImage,
    allowed: &GrayImage,
    options: &RemovalOptions,
) -> Result<GrayImage, String> {
    options.validate()?;
    if selection.dimensions() != allowed.dimensions() {
        return Err("Removal mask and protection dimensions differ".into());
    }
    let mut out = selection.clone();
    if options.enabled() {
        let core = GrayImage::from_fn(selection.width(), selection.height(), |x, y| {
            Luma([if selection.get_pixel(x, y)[0] >= 128 {
                255
            } else {
                0
            }])
        });
        if !core.pixels().any(|p| p[0] != 0) {
            return Err("Removal needs a selection with at least 50% opacity".into());
        }
        let distances = euclidean_squared_distance_transform(&core);
        for ((value, distance), original) in out
            .pixels_mut()
            .zip(distances.pixels())
            .zip(selection.pixels())
        {
            let distance = distance[0].sqrt();
            let t = if distance <= f64::from(options.expand_pixels) {
                1.0
            } else if options.feather_pixels == 0 {
                0.0
            } else {
                (1.0 - (distance - f64::from(options.expand_pixels))
                    / f64::from(options.feather_pixels))
                .clamp(0.0, 1.0)
            };
            value[0] = original[0].max((255.0 * t * t * (3.0 - 2.0 * t)).round() as u8);
        }
    }
    for (pixel, limit) in out.pixels_mut().zip(allowed.pixels()) {
        pixel[0] = ((u32::from(pixel[0]) * u32::from(limit[0]) + 127) / 255) as u8;
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_preserves_soft_alpha_exactly() {
        let mask = GrayImage::from_raw(5, 1, vec![0, 32, 127, 200, 255]).unwrap();
        let all = GrayImage::from_pixel(5, 1, Luma([255]));
        assert_eq!(
            effective_mask(&mask, &all, &RemovalOptions::default()).unwrap(),
            mask
        );
    }

    #[test]
    fn expands_core_then_feathers_outward_and_keeps_protection() {
        let mut mask = GrayImage::new(15, 15);
        mask.put_pixel(7, 7, Luma([255]));
        let mut allowed = GrayImage::from_pixel(15, 15, Luma([255]));
        allowed.put_pixel(8, 7, Luma([0]));
        let options = RemovalOptions {
            expand_pixels: 2,
            feather_pixels: 2,
        };
        let result = effective_mask(&mask, &allowed, &options).unwrap();
        assert_eq!(result.get_pixel(7, 7)[0], 255);
        assert_eq!(result.get_pixel(9, 7)[0], 255);
        assert_eq!(result.get_pixel(10, 7)[0], 128);
        assert_eq!(result.get_pixel(11, 7)[0], 0);
        assert_eq!(result.get_pixel(8, 7)[0], 0);
        assert_eq!(result.get_pixel(0, 0)[0], 0);
    }

    #[test]
    fn clipping_empty_and_invalid_inputs_are_explicit() {
        let mut mask = GrayImage::new(3, 3);
        let all = GrayImage::from_pixel(3, 3, Luma([255]));
        let options = RemovalOptions {
            expand_pixels: 2,
            feather_pixels: 0,
        };
        assert!(effective_mask(&mask, &all, &options).is_err());
        mask.put_pixel(0, 0, Luma([255]));
        let result = effective_mask(&mask, &all, &options).unwrap();
        assert_eq!(result.get_pixel(2, 0)[0], 255);
        assert_eq!(result.get_pixel(2, 2)[0], 0);
        assert!(effective_mask(&mask, &GrayImage::new(2, 2), &options).is_err());
        assert!(
            RemovalOptions {
                expand_pixels: 257,
                feather_pixels: 0
            }
            .validate()
            .is_err()
        );
        for value in [
            serde_json::json!({"expandPixels":-1}),
            serde_json::json!({"featherPixels":1.5}),
            serde_json::json!({"unknown":true}),
        ] {
            assert!(serde_json::from_value::<RemovalOptions>(value).is_err());
        }
    }
}
