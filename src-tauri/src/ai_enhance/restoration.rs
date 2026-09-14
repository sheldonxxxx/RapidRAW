//! Tiled, display-referred neural restoration with bounded intermediate buffers.
//!
//! The caller supplies sRGB pixels and a verified RGB/NCHW float32 ONNX model.
//! Alpha never enters the network. A tile's reflected context is discarded and
//! overlapping interiors crossfade; only one full-resolution result is allocated.

use anyhow::{Result, anyhow, bail, ensure};
use image::{DynamicImage, GenericImageView, Rgba32FImage};
use ort::{session::Session, tensor::TensorElementType, value::Tensor};
use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Clone, Copy, Debug)]
pub struct RestorationModel {
    pub scale: u32,
    pub input_multiple: u32,
}

#[derive(Clone, Copy, Debug)]
pub struct RestorationOptions {
    /// Complete inference tile including context, in source pixels.
    pub tile_size: u32,
    /// Context on each edge and crossfade width, in source pixels.
    pub overlap: u32,
    pub strength: f32,
    /// Must match the native model scale; repeated enhancement is not implicit.
    pub output_scale: u32,
    /// Applied before allocating the result. This is a pixel limit, not a total
    /// process-memory promise: the RGBA32F result alone uses 16 bytes per pixel.
    pub max_output_pixels: u64,
}

fn check_cancelled(cancelled: &AtomicBool) -> Result<()> {
    ensure!(
        !cancelled.load(Ordering::Relaxed),
        "ENHANCEMENT_CANCELLED: Restoration cancelled"
    );
    Ok(())
}

fn validate_prediction(values: &[f32], scale: u32) -> Result<()> {
    ensure!(
        values.iter().all(|v| v.is_finite()),
        "ENHANCEMENT_INVALID_OUTPUT: Model produced non-finite pixels"
    );
    if scale == 1 {
        // GoPro-trained deblurring can become unstable on strong sensor noise.
        // Clipping those predictions would hide large alternating colour errors.
        // This conservative numerical gate is not a general image-quality score.
        let extreme = values
            .iter()
            .filter(|&&v| !(-0.25..=1.25).contains(&v))
            .count();
        ensure!(
            extreme.saturating_mul(1000) <= values.len(),
            "ENHANCEMENT_UNSTABLE_OUTPUT: Deblurring produced excessive ringing. Denoise the photograph first or try a smaller area"
        );
    }
    Ok(())
}

fn validate(
    width: u32,
    height: u32,
    model: RestorationModel,
    options: RestorationOptions,
) -> Result<(u32, u32)> {
    ensure!(
        width > 0 && height > 0,
        "ENHANCEMENT_INVALID_IMAGE: Image is empty"
    );
    ensure!(
        matches!(model.scale, 1 | 2 | 4),
        "ENHANCEMENT_INVALID_MODEL: Unsupported scale"
    );
    ensure!(
        options.output_scale == model.scale,
        "ENHANCEMENT_SCALE_MISMATCH: Requested scale must match the model"
    );
    ensure!(
        options.strength.is_finite() && (0.0..=1.0).contains(&options.strength),
        "ENHANCEMENT_INVALID_OPTIONS: Strength must be between zero and one"
    );
    ensure!(
        (64..=512).contains(&options.tile_size)
            && model.input_multiple > 0
            && options.tile_size.is_multiple_of(model.input_multiple),
        "ENHANCEMENT_INVALID_OPTIONS: Tile size must be 64–512 and divisible by the model input multiple"
    );
    ensure!(
        options.overlap >= 8 && options.overlap <= options.tile_size / 4,
        "ENHANCEMENT_INVALID_OPTIONS: Context must be at least 8 pixels and no more than one quarter of the tile"
    );
    let output_width = width
        .checked_mul(model.scale)
        .ok_or_else(|| anyhow!("ENHANCEMENT_TOO_LARGE: Output width overflow"))?;
    let output_height = height
        .checked_mul(model.scale)
        .ok_or_else(|| anyhow!("ENHANCEMENT_TOO_LARGE: Output height overflow"))?;
    let pixels = u64::from(output_width) * u64::from(output_height);
    ensure!(
        options.max_output_pixels > 0
            && pixels <= options.max_output_pixels
            && pixels
                .checked_mul(16)
                .is_some_and(|bytes| bytes <= isize::MAX as u64),
        "ENHANCEMENT_TOO_LARGE: Output exceeds the configured pixel limit"
    );
    Ok((output_width, output_height))
}

/// Reflect without duplicating the edge pixel, including one-pixel images.
fn reflect(coordinate: i64, length: u32) -> u32 {
    if length <= 1 {
        return 0;
    }
    let period = 2 * (i64::from(length) - 1);
    let value = coordinate.rem_euclid(period);
    if value < i64::from(length) {
        value as u32
    } else {
        (period - value) as u32
    }
}

/// Preserve the precision of every supported DynamicImage variant. The generic
/// DynamicImage::get_pixel path converts floating-point inputs to eight bits.
fn pixel(source: &DynamicImage, x: u32, y: u32) -> [f32; 4] {
    match source {
        DynamicImage::ImageRgb32F(image) => {
            let p = image.get_pixel(x, y).0;
            [p[0], p[1], p[2], 1.0]
        }
        DynamicImage::ImageRgba32F(image) => image.get_pixel(x, y).0,
        DynamicImage::ImageRgb16(image) => {
            let p = image.get_pixel(x, y).0;
            [
                p[0] as f32 / 65535.0,
                p[1] as f32 / 65535.0,
                p[2] as f32 / 65535.0,
                1.0,
            ]
        }
        DynamicImage::ImageRgba16(image) => image.get_pixel(x, y).0.map(|v| v as f32 / 65535.0),
        DynamicImage::ImageLuma16(image) => {
            let v = image.get_pixel(x, y).0[0] as f32 / 65535.0;
            [v, v, v, 1.0]
        }
        DynamicImage::ImageLumaA16(image) => {
            let p = image.get_pixel(x, y).0;
            let v = p[0] as f32 / 65535.0;
            [v, v, v, p[1] as f32 / 65535.0]
        }
        _ => source.get_pixel(x, y).0.map(|v| v as f32 / 255.0),
    }
}

fn baseline(source: &DynamicImage, x: u32, y: u32, scale: u32, clipped: bool) -> [f32; 4] {
    let sample = |x, y| {
        let mut p = pixel(source, x, y);
        if clipped {
            for value in &mut p[..3] {
                *value = value.clamp(0.0, 1.0);
            }
        }
        p
    };
    if scale == 1 {
        return sample(x, y);
    }
    let (width, height) = source.dimensions();
    // Pixel-centre alignment matches the model's native scale. The neutral
    // strength result uses bilinear interpolation, without sharpening or AI.
    let sx = ((x as f64 + 0.5) / f64::from(scale) - 0.5).clamp(0.0, f64::from(width - 1));
    let sy = ((y as f64 + 0.5) / f64::from(scale) - 0.5).clamp(0.0, f64::from(height - 1));
    let ix = sx.floor() as u32;
    let iy = sy.floor() as u32;
    let tx = (sx - f64::from(ix)) as f32;
    let ty = (sy - f64::from(iy)) as f32;
    let a = sample(ix, iy);
    let b = sample((ix + 1).min(width - 1), iy);
    let c = sample(ix, (iy + 1).min(height - 1));
    let d = sample((ix + 1).min(width - 1), (iy + 1).min(height - 1));
    std::array::from_fn(|ch| {
        (a[ch] * (1.0 - tx) + b[ch] * tx) * (1.0 - ty) + (c[ch] * (1.0 - tx) + d[ch] * tx) * ty
    })
}

fn origins(length: u32, core: u32, overlap: u32) -> Vec<u32> {
    let mut result = vec![0u32];
    while result.last().copied().unwrap().saturating_add(core) < length {
        result.push(result.last().copied().unwrap() + core - overlap);
    }
    result
}

fn weight(position: u32, core: u32, overlap: u32, first: bool, last: bool) -> f32 {
    if !first && position < overlap {
        (position as f32 + 0.5) / overlap as f32
    } else if !last && position >= core - overlap {
        (core as f32 - position as f32 - 0.5) / overlap as f32
    } else {
        1.0
    }
}

/// Run verified RGB restoration. Cancellation is checked around each tile and
/// during compositing; an in-flight ONNX tile finishes before cancellation exits.
/// Failed inference is never silently replaced by ordinary sharpening/resizing.
pub fn restore(
    session: &mut Session,
    source: &DynamicImage,
    model: RestorationModel,
    options: RestorationOptions,
    cancelled: &AtomicBool,
    progress: &mut dyn FnMut(f32),
) -> Result<DynamicImage> {
    check_cancelled(cancelled)?;
    let (width, height) = source.dimensions();
    let (output_width, output_height) = validate(width, height, model, options)?;
    ensure!(
        session.inputs.len() == 1 && session.outputs.len() == 1,
        "ENHANCEMENT_INVALID_MODEL: Restoration expects one input and one output"
    );
    let input = &session.inputs[0].input_type;
    let shape = input
        .tensor_shape()
        .ok_or_else(|| anyhow!("ENHANCEMENT_INVALID_MODEL: Expected a tensor input"))?;
    ensure!(
        input.tensor_type() == Some(TensorElementType::Float32)
            && shape.len() == 4
            && (shape[0] == 1 || shape[0] == -1)
            && (shape[1] == 3 || shape[1] == -1),
        "ENHANCEMENT_INVALID_MODEL: Expected float32 RGB NCHW input"
    );
    for dimension in [shape[2], shape[3]] {
        ensure!(
            dimension == -1 || dimension == i64::from(options.tile_size),
            "ENHANCEMENT_TILE_MISMATCH: Fixed model input does not match the requested tile size"
        );
    }
    // Allocate explicitly with try_reserve so an unreasonable result fails
    // cleanly before inference instead of aborting the application on allocation.
    let elements = (u64::from(output_width) * u64::from(output_height) * 4) as usize;
    let mut data = Vec::<f32>::new();
    data.try_reserve_exact(elements)
        .map_err(|_| anyhow!("ENHANCEMENT_MEMORY_LIMIT: Could not allocate the output image"))?;
    data.resize(elements, 0.0);
    let mut output = Rgba32FImage::from_raw(output_width, output_height, data)
        .ok_or_else(|| anyhow!("ENHANCEMENT_INVALID_IMAGE: Invalid output dimensions"))?;
    let scale = model.scale;
    let tile = options.tile_size;
    let halo = options.overlap;
    let core = tile - 2 * halo;
    let xs = origins(width, core, halo);
    let ys = origins(height, core, halo);
    let total = xs.len() * ys.len();
    progress(0.0);
    let mut completed = 0;
    if options.strength > 0.0 {
        for (yi, &y0) in ys.iter().enumerate() {
            for (xi, &x0) in xs.iter().enumerate() {
                check_cancelled(cancelled)?;
                let area = tile as usize * tile as usize;
                let mut values = vec![0.0f32; area * 3];
                for y in 0..tile {
                    for x in 0..tile {
                        let p = pixel(
                            source,
                            reflect(i64::from(x0) + i64::from(x) - i64::from(halo), width),
                            reflect(i64::from(y0) + i64::from(y) - i64::from(halo), height),
                        );
                        ensure!(
                            p.iter().all(|v| v.is_finite()),
                            "ENHANCEMENT_INVALID_IMAGE: Non-finite source pixels"
                        );
                        for ch in 0..3 {
                            values[ch * area + y as usize * tile as usize + x as usize] =
                                p[ch].clamp(0.0, 1.0);
                        }
                    }
                }
                let tensor =
                    Tensor::from_array(([1usize, 3, tile as usize, tile as usize], values))?;
                let result = session.run(ort::inputs![tensor])?;
                check_cancelled(cancelled)?;
                let (result_shape, result_values) = result[0].try_extract_tensor::<f32>()?;
                let side = tile * scale;
                ensure!(
                    **result_shape == [1, 3, i64::from(side), i64::from(side)],
                    "ENHANCEMENT_INVALID_OUTPUT: Restoration output shape does not match the model scale"
                );
                validate_prediction(result_values, scale)?;
                let plane = side as usize * side as usize;
                for y in 0..core.min(height - y0) * scale {
                    if y % 32 == 0 {
                        check_cancelled(cancelled)?;
                    }
                    let wy = weight(y, core * scale, halo * scale, yi == 0, yi + 1 == ys.len());
                    for x in 0..core.min(width - x0) * scale {
                        let w =
                            wy * weight(x, core * scale, halo * scale, xi == 0, xi + 1 == xs.len());
                        let index = (y + halo * scale) as usize * side as usize
                            + (x + halo * scale) as usize;
                        let p = output.get_pixel_mut(x0 * scale + x, y0 * scale + y);
                        for ch in 0..3 {
                            p.0[ch] += w * result_values[ch * plane + index];
                        }
                    }
                }
                completed += 1;
                progress(0.95 * completed as f32 / total as f32);
            }
        }
    }
    for y in 0..output_height {
        if y % 32 == 0 {
            check_cancelled(cancelled)?;
        }
        for x in 0..output_width {
            let base = baseline(source, x, y, scale, false);
            let clipped_base = baseline(source, x, y, scale, true);
            if base.iter().any(|v| !v.is_finite()) {
                bail!("ENHANCEMENT_INVALID_IMAGE: Non-finite source pixels");
            }
            let p = output.get_pixel_mut(x, y);
            for ch in 0..3 {
                // Add the learned delta to the unclipped source. This retains
                // out-of-range floating-point highlights instead of clipping them.
                p.0[ch] = base[ch] + options.strength * (p.0[ch] - clipped_base[ch]);
            }
            p.0[3] = base[3];
        }
    }
    check_cancelled(cancelled)?;
    progress(1.0);
    Ok(DynamicImage::ImageRgba32F(output))
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgba;

    #[test]
    fn crossfades_cover_odd_and_small_images_exactly_once() {
        for (core, overlap) in [(32, 16), (192, 32), (256, 64)] {
            for length in [1, 17, 191, 192, 193, 509, 1000] {
                let starts = origins(length, core, overlap);
                for scale in [1, 2, 4] {
                    let mut weights = vec![0.0; (length * scale) as usize];
                    for (i, &start) in starts.iter().enumerate() {
                        for x in 0..core.min(length - start) * scale {
                            weights[(start * scale + x) as usize] += weight(
                                x,
                                core * scale,
                                overlap * scale,
                                i == 0,
                                i + 1 == starts.len(),
                            );
                        }
                    }
                    assert!(weights.iter().all(|w| (w - 1.0f32).abs() < 1e-6));
                }
            }
        }
    }

    #[test]
    fn reflection_handles_tiny_images_and_far_context() {
        for length in [1, 2, 3, 17] {
            for x in -1000..1000 {
                assert!(reflect(x, length) < length);
            }
        }
        assert_eq!(
            (-3..7).map(|x| reflect(x, 3)).collect::<Vec<_>>(),
            vec![1, 2, 1, 0, 1, 2, 1, 0, 1, 2]
        );
    }

    #[test]
    fn float_precision_hdr_and_alpha_survive_sampling() {
        let input = DynamicImage::ImageRgba32F(Rgba32FImage::from_pixel(
            1,
            1,
            Rgba([0.123456, 1.4, -0.01, 0.4]),
        ));
        assert_eq!(pixel(&input, 0, 0), [0.123456, 1.4, -0.01, 0.4]);
        assert_eq!(
            baseline(&input, 1, 1, 2, false),
            [0.123456, 1.4, -0.01, 0.4]
        );
        let edge = DynamicImage::ImageRgba32F(Rgba32FImage::from_fn(2, 1, |x, _| {
            Rgba([x as f32 * 2.0, 0.0, 0.0, 1.0])
        }));
        assert_eq!(baseline(&edge, 1, 0, 2, false)[0], 0.5);
        assert_eq!(baseline(&edge, 1, 0, 2, true)[0], 0.25);
    }

    #[test]
    fn invalid_sizes_scales_and_memory_limits_fail_before_allocation() {
        let model = RestorationModel {
            scale: 2,
            input_multiple: 8,
        };
        let options = RestorationOptions {
            tile_size: 128,
            overlap: 24,
            strength: 0.5,
            output_scale: 2,
            max_output_pixels: 4_000_000,
        };
        assert_eq!(validate(1000, 1000, model, options).unwrap(), (2000, 2000));
        assert!(validate(1001, 1000, model, options).is_err());
        assert!(validate(0, 10, model, options).is_err());
        assert!(validate(u32::MAX, 1, model, options).is_err());
        assert!(
            validate(
                10,
                10,
                model,
                RestorationOptions {
                    strength: f32::NAN,
                    ..options
                }
            )
            .is_err()
        );
        assert!(
            validate(
                10,
                10,
                model,
                RestorationOptions {
                    overlap: 40,
                    ..options
                }
            )
            .is_err()
        );
        assert!(
            validate(
                10,
                10,
                model,
                RestorationOptions {
                    output_scale: 1,
                    ..options
                }
            )
            .is_err()
        );
    }

    #[test]
    fn deblur_rejects_explosive_finite_output_without_clipping_it() {
        let mut prediction = vec![0.5; 10_000];
        prediction[0] = f32::NAN;
        assert!(validate_prediction(&prediction, 2).is_err());
        prediction[0] = 1.1;
        assert!(validate_prediction(&prediction, 1).is_ok());
        for value in &mut prediction[..100] {
            *value = 2.8;
        }
        assert!(validate_prediction(&prediction, 1).is_err());
    }
}
