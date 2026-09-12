//! Exact preview caching and visual/photometric review helpers.
use super::*;
use std::{
    collections::VecDeque,
    sync::{Mutex, OnceLock},
};

const CACHE_BYTES: usize = 64 * 1024 * 1024;
struct Cached {
    key: String,
    response: Value,
    bytes: usize,
}
static PREVIEWS: OnceLock<Mutex<VecDeque<Cached>>> = OnceLock::new();

pub(super) fn cache_key(bridge: &Bridge, session: &Session, params: &Value) -> Result<String> {
    if bridge.active.as_deref() != Some(session.id.as_str()) {
        return Err("SESSION_NOT_ACTIVE: Activate the session before rendering".into());
    }
    let settings = crate::app_settings::load_settings(bridge.handle.clone())?;
    let state = bridge.handle.state::<AppState>();
    let source = state.original_image.lock().map_err(|e| e.to_string())?;
    let loaded = source
        .as_ref()
        .ok_or("IMAGE_NOT_LOADED: No active source image")?;
    if loaded.path != session.working_path {
        return Err("SESSION_NOT_ACTIVE: Source differs from session".into());
    }
    let mut hash = blake3::Hasher::new();
    let identity = json!({"workspace":bridge.paths.root,"session":session.id,"revision":session.revision,
        "working_path":session.working_path,"source_sha256":session.source_sha256,"is_raw":session.is_raw,
        "loaded_image_identity":Arc::as_ptr(&loaded.image) as usize,
        "adjustments":session.current().adjustments,"settings":settings,"params":params});
    hash.update(&serde_json::to_vec(&identity).map_err(|e| e.to_string())?);
    if let Some(path) = session.current().adjustments["lutPath"]
        .as_str()
        .filter(|p| !p.is_empty())
    {
        hash.update(&fs::read(path).map_err(|e| format!("LUT_LOAD_FAILED: {e}"))?);
    }
    Ok(hash.finalize().to_hex().to_string())
}

pub(super) fn cached_preview(key: &str) -> Option<Value> {
    let mut cache = PREVIEWS
        .get_or_init(|| Mutex::new(VecDeque::new()))
        .lock()
        .ok()?;
    let position = cache.iter().position(|entry| entry.key == key)?;
    let entry = cache.remove(position)?;
    let response = entry.response.clone();
    cache.push_back(entry);
    Some(response)
}

pub(super) fn cache_preview(key: String, response: &Value) {
    let Ok(bytes) = serde_json::to_vec(response).map(|v| v.len()) else {
        return;
    };
    if bytes > CACHE_BYTES / 2 {
        return;
    }
    let Ok(mut cache) = PREVIEWS.get_or_init(|| Mutex::new(VecDeque::new())).lock() else {
        return;
    };
    cache.retain(|entry| entry.key != key);
    while cache.iter().map(|entry| entry.bytes).sum::<usize>() + bytes > CACHE_BYTES
        || cache.len() >= 16
    {
        cache.pop_front();
    }
    cache.push_back(Cached {
        key,
        response: response.clone(),
        bytes,
    });
}

pub(super) fn mask_bounds(mask: &GrayImage, offset: (u32, u32), threshold: u8) -> Value {
    let (mut min_x, mut min_y, mut max_x, mut max_y) = (u32::MAX, u32::MAX, 0, 0);
    for (x, y, p) in mask.enumerate_pixels() {
        if p[0] >= threshold {
            min_x = min_x.min(x);
            min_y = min_y.min(y);
            max_x = max_x.max(x);
            max_y = max_y.max(y);
        }
    }
    if min_x == u32::MAX {
        Value::Null
    } else {
        json!({"x":min_x+offset.0,"y":min_y+offset.1,"width":max_x-min_x+1,"height":max_y-min_y+1,"threshold":threshold})
    }
}

pub(super) fn overlay_mask(
    image: &DynamicImage,
    mask: &GrayImage,
    opacity: f64,
) -> Result<DynamicImage> {
    if image.dimensions() != mask.dimensions() {
        return Err("MASK_DIMENSIONS: Image and mask must match".into());
    }
    let mut image = image.to_rgb16();
    for (rgb, alpha) in image.pixels_mut().zip(mask.pixels()) {
        let weight = alpha[0] as f64 / 255.0 * opacity;
        for c in 0..3 {
            rgb[c] = ((rgb[c] as f64) * (1.0 - weight) + [65535.0, 0.0, 65535.0][c] * weight)
                .round() as u16;
        }
    }
    Ok(DynamicImage::ImageRgb16(image))
}

pub(super) fn clipping_overlay(image: &DynamicImage) -> DynamicImage {
    let mut image = image.to_rgb16();
    for pixel in image.pixels_mut() {
        if pixel.0.contains(&65535) {
            *pixel = image::Rgb([65535, 0, 0]);
        } else if pixel.0.contains(&0) {
            *pixel = image::Rgb([0, 0, 65535]);
        }
    }
    DynamicImage::ImageRgb16(image)
}

fn linear(value: f64) -> f64 {
    if value <= 0.04045 {
        value / 12.92
    } else {
        ((value + 0.055) / 1.055).powf(2.4)
    }
}

pub(super) fn weighted_statistics(image: &DynamicImage, mask: &GrayImage) -> Value {
    let image = image.to_rgb16();
    let mut weight = 0.0;
    let mut rgb = [0.0; 3];
    let mut luminance = 0.0;
    for (p, m) in image.pixels().zip(mask.pixels()) {
        let w = m[0] as f64 / 255.0;
        weight += w;
        let color = p.0.map(|v| v as f64 / 65535.0);
        for c in 0..3 {
            rgb[c] += color[c] * w;
        }
        luminance +=
            (linear(color[0]) * 0.2126 + linear(color[1]) * 0.7152 + linear(color[2]) * 0.0722) * w;
    }
    if weight == 0.0 {
        return json!({"weight":0,"mean_rgb":null,"mean_linear_luminance":null});
    }
    json!({"weight":weight,"mean_rgb":rgb.map(|v|v/weight),"mean_linear_luminance":luminance/weight,"scope":"Mask-weighted native rendered sRGB samples; luminance uses decoded linear sRGB Rec.709 weights"})
}

fn quantile(histogram: &[u64], count: u64, fraction: f64) -> f64 {
    let target = ((count.saturating_sub(1)) as f64 * fraction).round() as u64;
    let mut seen = 0;
    for (level, n) in histogram.iter().enumerate() {
        seen += n;
        if seen > target {
            return level as f64 / 65535.0;
        }
    }
    0.0
}

fn robust_statistics(image: &DynamicImage) -> Value {
    let image = image.to_rgb16();
    let mut channels = vec![vec![0u64; 65536]; 3];
    let mut luma = vec![0u64; 65536];
    let count = image.width() as u64 * image.height() as u64;
    let mut sum = [0.0; 3];
    let mut linear_sum = 0.0;
    let mut clipped = 0;
    for p in image.pixels() {
        for c in 0..3 {
            channels[c][p[c] as usize] += 1;
            sum[c] += p[c] as f64 / 65535.0;
        }
        let color = p.0.map(|v| linear(v as f64 / 65535.0));
        let luminance = color[0] * 0.2126 + color[1] * 0.7152 + color[2] * 0.0722;
        linear_sum += luminance;
        luma[(luminance * 65535.0).round().clamp(0.0, 65535.0) as usize] += 1;
        if p.0.contains(&0) || p.0.contains(&65535) {
            clipped += 1;
        }
    }
    let rgb_quantiles = |q: f64| {
        channels
            .iter()
            .map(|h| quantile(h, count, q))
            .collect::<Vec<_>>()
    };
    json!({"pixels":count,"mean_rgb":sum.map(|v|v/count as f64),"median_rgb":rgb_quantiles(0.5),"p05_rgb":rgb_quantiles(0.05),"p95_rgb":rgb_quantiles(0.95),
        "mean_linear_luminance":linear_sum/count as f64,"median_linear_luminance":quantile(&luma,count,0.5),"p05_linear_luminance":quantile(&luma,count,0.05),"p95_linear_luminance":quantile(&luma,count,0.95),"clipped_fraction":clipped as f64/count as f64})
}

fn neutral_error(stats: &Value) -> Result<[f64; 2]> {
    let color: Vec<f64> = stats["median_rgb"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| linear(v.as_f64().unwrap()))
        .collect();
    if color.iter().any(|v| *v < 0.0005 || *v > 0.98) {
        return Err("UNSUITABLE_NEUTRAL_PATCH: Median sample is too dark or clipped for a stable white-balance suggestion".into());
    }
    Ok([(color[0] / color[1]).ln(), (color[2] / color[1]).ln()])
}
fn norm(e: [f64; 2]) -> f64 {
    e[0].hypot(e[1])
}

impl Bridge {
    pub(crate) fn sample_region(&self, session: &Session, params: &Value) -> Result<Value> {
        let stage = params["stage"].as_str().unwrap_or("edited");
        if !["edited", "original"].contains(&stage) {
            return Err("INVALID_ARGUMENT: stage must be edited or original".into());
        }
        if params.get("region").is_none() {
            return Err("INVALID_ARGUMENT: sample_region requires region in the selected stage's rendered coordinates".into());
        }
        let prepared = self.prepare_render(session, stage == "original")?;
        let region = parse_region(params.get("region"), prepared.image.dimensions())?;
        if region.width as u64 * region.height as u64 > 4_000_000 {
            return Err(
                "INVALID_REGION: sample_region is limited to 4 megapixels; select a smaller patch"
                    .into(),
            );
        }
        let image = self.render_prepared(session, &prepared, region, None)?;
        let stats = robust_statistics(&image);
        let mut response = json!({"session_id":session.id,"revision":session.revision,"stage":stage,
            "processing_stage":"Native rendered display sRGB after tone mapping, before preview resize/encoding; original bypasses user edits, retaining source decode and native baseline processing",
            "region":{"x":region.x,"y":region.y,"width":region.width,"height":region.height},
            "rgb_encoding":"sRGB normalized 0..1, 16-bit readback", "luminance_encoding":"linear sRGB Rec.709 luminance, normalized 0..1", "statistics":stats,"state_unchanged":true});
        if flag(params, "suggest_white_balance", false)? {
            if stage != "edited" {
                return Err("INVALID_ARGUMENT: White-balance suggestions require stage=edited so candidates preserve the current edit".into());
            }
            response["white_balance_suggestion"] =
                match self.white_balance_suggestion(session, prepared, region, &stats) {
                    Ok(v) => v,
                    Err(reason) => json!({"available":false,"reason":reason,"applied":false}),
                };
        }
        Ok(response)
    }

    fn white_balance_suggestion(
        &self,
        session: &Session,
        mut prepared: Prepared,
        region: Roi,
        initial: &Value,
    ) -> Result<Value> {
        let mut error = neutral_error(initial)?;
        let initial_error = norm(error);
        let mut values = [
            prepared.adjustments["temperature"].as_f64().unwrap_or(0.0),
            prepared.adjustments["tint"].as_f64().unwrap_or(0.0),
        ];
        let initial_values = values;
        let mut renders = 0;
        let evaluate = |state: &mut Prepared, v: [f64; 2]| -> Result<[f64; 2]> {
            state.adjustments["temperature"] = json!(v[0]);
            state.adjustments["tint"] = json!(v[1]);
            let image = self.render_prepared(session, state, region, None)?;
            neutral_error(&robust_statistics(&image))
        };
        // Finite differences are measured through the native renderer, preserving
        // LUTs, masks and tone mapping. No assumed Kelvin-to-slider conversion.
        for _ in 0..6 {
            if norm(error) < 0.005 {
                break;
            }
            let mut jac = [[0.0; 2]; 2];
            for c in 0..2 {
                let mut trial = values;
                let step = if values[c] > 98.0 { -2.0 } else { 2.0 };
                trial[c] += step;
                let measured = evaluate(&mut prepared, trial)?;
                renders += 1;
                jac[0][c] = (measured[0] - error[0]) / step;
                jac[1][c] = (measured[1] - error[1]) / step;
            }
            let determinant = jac[0][0] * jac[1][1] - jac[0][1] * jac[1][0];
            if determinant.abs() < 1e-10 {
                break;
            }
            let delta = [
                (jac[1][1] * error[0] - jac[0][1] * error[1]) / determinant,
                (-jac[1][0] * error[0] + jac[0][0] * error[1]) / determinant,
            ];
            let mut improved = false;
            for scale in [1.0, 0.5, 0.25] {
                let trial = [
                    (values[0] - delta[0].clamp(-60.0, 60.0) * scale).clamp(-100.0, 100.0),
                    (values[1] - delta[1].clamp(-60.0, 60.0) * scale).clamp(-100.0, 100.0),
                ];
                let measured = evaluate(&mut prepared, trial)?;
                renders += 1;
                if norm(measured) < norm(error) {
                    values = trial;
                    error = measured;
                    improved = true;
                    break;
                }
            }
            if !improved {
                break;
            }
        }
        let improved = norm(error) < initial_error - 0.0001;
        Ok(
            json!({"available":improved||initial_error<0.005,"applied":false,"patch":{"temperature":values[0],"tint":values[1]},
            "initial_values":{"temperature":initial_values[0],"tint":initial_values[1]},"initial_neutral_error":initial_error,"candidate_neutral_error":norm(error),"native_candidate_renders":renders,
            "method":"Finite-difference optimization of median linear R/G and B/G ratios, measured through the unchanged native rendering pipeline",
            "assumption":"The selected patch should be neutral gray or white; neutrality is not inferred from image content. Global temperature and tint are the only proposed changes."}),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn mask_overlay_and_bounds_preserve_the_selected_pixels() {
        let image = DynamicImage::ImageRgb16(ImageBuffer::from_pixel(
            5,
            4,
            image::Rgb([10000, 20000, 30000]),
        ));
        let mut mask = GrayImage::new(5, 4);
        mask.put_pixel(2, 1, Luma([255]));
        mask.put_pixel(3, 1, Luma([64]));
        assert_eq!(
            mask_bounds(&mask, (10, 20), 1),
            json!({"x":12,"y":21,"width":2,"height":1,"threshold":1})
        );
        assert_eq!(
            mask_bounds(&mask, (10, 20), 128),
            json!({"x":12,"y":21,"width":1,"height":1,"threshold":128})
        );
        let out = overlay_mask(&image, &mask, 1.0).unwrap().to_rgb16();
        assert_eq!(out.get_pixel(2, 1).0, [65535, 0, 65535]);
        assert_eq!(out.get_pixel(0, 0).0, [10000, 20000, 30000]);
        assert_eq!(
            weighted_statistics(&image, &GrayImage::new(5, 4))["mean_rgb"],
            Value::Null
        );
    }
    #[test]
    fn clipping_and_robust_measurements_are_separate() {
        let mut image = ImageBuffer::from_pixel(101, 1, image::Rgb([32768u16; 3]));
        image.put_pixel(0, 0, image::Rgb([65535, 100, 200]));
        image.put_pixel(1, 0, image::Rgb([100, 0, 200]));
        let input = DynamicImage::ImageRgb16(image);
        let stats = robust_statistics(&input);
        assert!((stats["median_rgb"][0].as_f64().unwrap() - 0.5).abs() < 0.00002);
        assert!((stats["median_linear_luminance"].as_f64().unwrap() - 0.214).abs() < 0.001);
        let overlay = clipping_overlay(&input).to_rgb16();
        assert_eq!(overlay.get_pixel(0, 0).0, [65535, 0, 0]);
        assert_eq!(overlay.get_pixel(1, 0).0, [0, 0, 65535]);
        assert_eq!(input.to_rgb16().get_pixel(0, 0).0, [65535, 100, 200]);
    }
    #[test]
    fn exact_preview_cache_is_bounded_and_replaces_existing_keys() {
        cache_preview("review-test-one".into(), &json!({"image":"old"}));
        cache_preview("review-test-one".into(), &json!({"image":"new"}));
        assert_eq!(cached_preview("review-test-one").unwrap()["image"], "new");
        assert!(cached_preview("nonexistent-review-key").is_none());
    }
}
