use crate::baseline_exposure::BaselineOptions;
use crate::image_loader::composite_patches_on_image;
use crate::image_processing::resolve_tonemapper_override_from_handle;
use std::borrow::Cow;
use std::collections::HashMap;
use std::fs;
use std::io::{Cursor, Seek, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use image::codecs::jpeg::{JpegEncoder, PixelDensity};
use image::codecs::png::PngEncoder;
use image::{DynamicImage, GenericImageView, GrayImage, ImageBuffer, ImageFormat, Luma, imageops};
use jxl_encoder::{
    LossyConfig, PixelLayout,
    api::{calibrated_jxl_quality, quality_to_distance},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::Emitter;
use tauri::Manager;
use tiff::encoder::{Rational, TiffEncoder, TiffValue, colortype};
use tiff::tags::ResolutionUnit;

use crate::AppState;
use crate::delivery;
use crate::exif_processing;
use crate::file_management::{
    generate_filename_from_template, parse_virtual_path, read_file_mapped,
};
use crate::formats::is_raw_file;
use crate::image_loader::{load_and_composite, load_base_image_from_bytes, prepare_base_image_cow};
use crate::image_processing::{
    AllAdjustments, Crop, GpuContext, RenderOptions, RenderOutputPrecision, RenderRequest,
    downscale_f32_image, get_or_init_gpu_context, process_and_get_dynamic_image,
    process_and_get_dynamic_image_with_precision, resolve_render_options_from_handle,
};
use crate::lut_processing::{
    convert_image_to_cube_lut, generate_identity_lut_image, get_or_load_lut,
};
use crate::mask_generation::render_source_mask_bitmaps;

use crate::as_shot::as_shot;
use crate::cache_utils::{calculate_full_job_hash, calculate_transform_hash};
use crate::{
    apply_all_transformations, generate_transformed_preview, hydrate_adjustments, load_settings,
};

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Default)]
#[serde(try_from = "u8", into = "u8")]
pub enum TiffBitDepth {
    Eight = 8,
    #[default]
    Sixteen = 16,
}

impl TryFrom<u8> for TiffBitDepth {
    type Error = String;

    fn try_from(value: u8) -> Result<Self, Self::Error> {
        match value {
            8 => Ok(Self::Eight),
            16 => Ok(Self::Sixteen),
            _ => Err(format!(
                "Invalid TIFF bit depth '{}'; expected 8 or 16.",
                value
            )),
        }
    }
}

impl From<TiffBitDepth> for u8 {
    fn from(value: TiffBitDepth) -> Self {
        value as u8
    }
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub enum ResizeMode {
    LongEdge,
    ShortEdge,
    Width,
    Height,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ResizeOptions {
    pub mode: ResizeMode,
    pub value: u32,
    pub dont_enlarge: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
#[allow(clippy::enum_variant_names)]
pub enum BorderBasis {
    #[default]
    LongEdge,
    ShortEdge,
    EachEdge,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BorderOptions {
    #[serde(default)]
    pub basis: BorderBasis,
    pub horizontal_percent: f32,
    pub vertical_percent: f32,
    pub color: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PadOptions {
    pub ratio_width: f32,
    pub ratio_height: f32,
    pub color: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ExportSettings {
    pub jpeg_quality: u8,
    #[serde(default)]
    pub tiff_bit_depth: TiffBitDepth,
    pub resize: Option<ResizeOptions>,
    #[serde(default)]
    pub border: Option<BorderOptions>,
    #[serde(default)]
    pub pad: Option<PadOptions>,
    pub keep_metadata: bool,
    #[serde(default)]
    pub preserve_timestamps: bool,
    pub strip_gps: bool,
    pub filename_template: Option<String>,
    pub watermark: Option<WatermarkSettings>,
    #[serde(default)]
    pub export_masks: bool,
    #[serde(default)]
    pub preserve_folders: bool,
    #[serde(default)]
    pub destination_type: Option<String>,
    #[serde(default)]
    pub subfolder: Option<String>,
    #[serde(default)]
    pub dpi: Option<u16>,
}

#[derive(Clone)]
pub(crate) enum ExportAdjustmentsMode {
    UseSidecars {
        active_path: Option<String>,
        active_adjustments: Option<Value>,
    },
    GlobalOverride(Value),
}

fn is_current_edit(path: &str, active_path: Option<&str>) -> bool {
    Some(path) == active_path
}

impl ExportAdjustmentsMode {
    fn is_current_edit(&self, path: &str) -> bool {
        match self {
            Self::UseSidecars { active_path, .. } => is_current_edit(path, active_path.as_deref()),
            Self::GlobalOverride(_) => false,
        }
    }

    fn adjustments_for(&self, path: &str) -> Value {
        match self {
            Self::GlobalOverride(adjustments) => adjustments.clone(),
            Self::UseSidecars {
                active_adjustments, ..
            } => {
                if self.is_current_edit(path)
                    && let Some(adjustments) = active_adjustments
                {
                    return adjustments.clone();
                }
                let (_, sidecar) = parse_virtual_path(path);
                crate::exif_processing::load_sidecar(&sidecar).adjustments
            }
        }
    }
}

#[cfg(test)]
mod export_identity_tests {
    use super::*;

    #[test]
    fn live_adjustments_apply_only_to_the_selected_original_or_virtual_copy() {
        let dir = tempfile::tempdir().unwrap();
        let original = dir.path().join("photo.CR3").to_string_lossy().into_owned();
        let copy = format!("{original}?vc=abcdef");
        for (path, exposure) in [(&original, 1), (&copy, 2)] {
            let (_, sidecar) = parse_virtual_path(path);
            let metadata = crate::image_processing::ImageMetadata {
                adjustments: serde_json::json!({"exposure":exposure}),
                ..Default::default()
            };
            fs::write(sidecar, serde_json::to_vec(&metadata).unwrap()).unwrap();
        }
        let live = serde_json::json!({"exposure":3});
        for (active, other, saved) in [(&original, &copy, 2), (&copy, &original, 1)] {
            let mode = ExportAdjustmentsMode::UseSidecars {
                active_path: Some(active.clone()),
                active_adjustments: Some(live.clone()),
            };
            assert!(mode.is_current_edit(active));
            assert!(!mode.is_current_edit(other));
            assert_eq!(mode.adjustments_for(active), live);
            assert_eq!(mode.adjustments_for(other)["exposure"], saved);
            assert!(is_current_edit(active, Some(active)));
            assert!(!is_current_edit(other, Some(active)));
        }
        let saved = ExportAdjustmentsMode::UseSidecars {
            active_path: Some(copy.clone()),
            active_adjustments: None,
        };
        assert_eq!(saved.adjustments_for(&copy)["exposure"], 2);
        let global = ExportAdjustmentsMode::GlobalOverride(live.clone());
        assert!(!global.is_current_edit(&original));
        assert_eq!(global.adjustments_for(&original), live);
        assert_eq!(global.adjustments_for(&copy), live);
    }
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub enum WatermarkAnchor {
    TopLeft,
    TopCenter,
    TopRight,
    CenterLeft,
    Center,
    CenterRight,
    BottomLeft,
    BottomCenter,
    BottomRight,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WatermarkSettings {
    pub path: String,
    pub anchor: WatermarkAnchor,
    pub scale: f32,
    pub spacing: f32,
    pub opacity: f32,
}

struct WatermarkCacheEntry {
    path: String,
    modified: Option<std::time::SystemTime>,
    len: Option<u64>,
    image: Arc<DynamicImage>,
    scaled: Option<((u32, u32), Arc<DynamicImage>)>,
}

static WATERMARK_CACHE: Mutex<Option<WatermarkCacheEntry>> = Mutex::new(None);

struct WatermarkCacheGuard;

impl Drop for WatermarkCacheGuard {
    fn drop(&mut self) {
        *WATERMARK_CACHE.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }
}

fn load_watermark_image(path: &str) -> Result<Arc<DynamicImage>, String> {
    let metadata = fs::metadata(path).ok();
    let modified = metadata.as_ref().and_then(|m| m.modified().ok());
    let len = metadata.as_ref().map(|m| m.len());
    let mut cache = WATERMARK_CACHE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(entry) = cache.as_ref()
        && entry.path == path
        && entry.modified.is_some()
        && entry.modified == modified
        && entry.len == len
    {
        return Ok(Arc::clone(&entry.image));
    }
    let image =
        Arc::new(image::open(path).map_err(|e| format!("Failed to open watermark image: {}", e))?);
    *cache = Some(WatermarkCacheEntry {
        path: path.to_string(),
        modified,
        len,
        image: Arc::clone(&image),
        scaled: None,
    });
    Ok(image)
}

fn scaled_watermark_image(
    path: &str,
    watermark_img: &Arc<DynamicImage>,
    new_wm_w: u32,
    new_wm_h: u32,
) -> Arc<DynamicImage> {
    {
        let cache = WATERMARK_CACHE.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(entry) = cache.as_ref()
            && entry.path == path
            && Arc::ptr_eq(&entry.image, watermark_img)
            && let Some((size, scaled)) = &entry.scaled
            && *size == (new_wm_w, new_wm_h)
        {
            return Arc::clone(scaled);
        }
    }
    let scaled = Arc::new(watermark_img.resize_exact(
        new_wm_w,
        new_wm_h,
        image::imageops::FilterType::Lanczos3,
    ));
    let mut cache = WATERMARK_CACHE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(entry) = cache.as_mut()
        && entry.path == path
        && Arc::ptr_eq(&entry.image, watermark_img)
    {
        entry.scaled = Some(((new_wm_w, new_wm_h), Arc::clone(&scaled)));
    }
    scaled
}

fn apply_watermark(
    base_image: &mut DynamicImage,
    watermark_settings: &WatermarkSettings,
) -> Result<(), String> {
    let watermark_img = load_watermark_image(&watermark_settings.path)?;

    let (base_w, base_h) = base_image.dimensions();
    let base_min_dim = base_w.min(base_h) as f32;

    let watermark_scale_factor =
        (base_min_dim * (watermark_settings.scale / 100.0)) / watermark_img.width().max(1) as f32;
    let new_wm_w = (watermark_img.width() as f32 * watermark_scale_factor).round() as u32;
    let new_wm_h = (watermark_img.height() as f32 * watermark_scale_factor).round() as u32;

    if new_wm_w == 0 || new_wm_h == 0 {
        return Ok(());
    }

    let scaled_watermark =
        scaled_watermark_image(&watermark_settings.path, &watermark_img, new_wm_w, new_wm_h);
    let opacity_factor = (watermark_settings.opacity / 100.0).clamp(0.0, 1.0);

    let spacing_pixels = (base_min_dim * (watermark_settings.spacing / 100.0)) as i64;
    let (wm_w, wm_h) = scaled_watermark.dimensions();

    let x = match watermark_settings.anchor {
        WatermarkAnchor::TopLeft | WatermarkAnchor::CenterLeft | WatermarkAnchor::BottomLeft => {
            spacing_pixels
        }
        WatermarkAnchor::TopCenter | WatermarkAnchor::Center | WatermarkAnchor::BottomCenter => {
            (base_w as i64 - wm_w as i64) / 2
        }
        WatermarkAnchor::TopRight | WatermarkAnchor::CenterRight | WatermarkAnchor::BottomRight => {
            base_w as i64 - wm_w as i64 - spacing_pixels
        }
    };

    let y = match watermark_settings.anchor {
        WatermarkAnchor::TopLeft | WatermarkAnchor::TopCenter | WatermarkAnchor::TopRight => {
            spacing_pixels
        }
        WatermarkAnchor::CenterLeft | WatermarkAnchor::Center | WatermarkAnchor::CenterRight => {
            (base_h as i64 - wm_h as i64) / 2
        }
        WatermarkAnchor::BottomLeft
        | WatermarkAnchor::BottomCenter
        | WatermarkAnchor::BottomRight => base_h as i64 - wm_h as i64 - spacing_pixels,
    };

    if matches!(
        base_image,
        DynamicImage::ImageRgb16(_) | DynamicImage::ImageRgba16(_)
    ) {
        let mut base_rgba = base_image.to_rgba16();
        let mut watermark_rgba = scaled_watermark.to_rgba16();
        for pixel in watermark_rgba.pixels_mut() {
            pixel[3] = (pixel[3] as f32 * opacity_factor).round() as u16;
        }
        image::imageops::overlay(&mut base_rgba, &watermark_rgba, x, y);
        *base_image = DynamicImage::ImageRgba16(base_rgba);
    } else if matches!(
        base_image,
        DynamicImage::ImageRgb32F(_) | DynamicImage::ImageRgba32F(_)
    ) {
        let mut base_rgba = base_image.to_rgba32f();
        let mut watermark_rgba = scaled_watermark.to_rgba32f();
        for pixel in watermark_rgba.pixels_mut() {
            pixel[3] *= opacity_factor;
        }
        image::imageops::overlay(&mut base_rgba, &watermark_rgba, x, y);
        *base_image = DynamicImage::ImageRgba32F(base_rgba);
    } else {
        let mut watermark_rgba = scaled_watermark.to_rgba8();
        for pixel in watermark_rgba.pixels_mut() {
            pixel[3] = (pixel[3] as f32 * opacity_factor).round() as u8;
        }
        if let DynamicImage::ImageRgba8(base_rgba) = base_image {
            image::imageops::overlay(base_rgba, &watermark_rgba, x, y);
        } else {
            let mut base_rgba = base_image.to_rgba8();
            image::imageops::overlay(&mut base_rgba, &watermark_rgba, x, y);
            *base_image = DynamicImage::ImageRgba8(base_rgba);
        }
    }

    Ok(())
}

const PAD_RATIO_EPSILON: f64 = 0.001;
const MAX_PAD_DIMENSION: u32 = 65_535;
const MAX_BORDER_PERCENT: f64 = 100.0;

#[derive(Debug, Clone, Copy)]
pub(crate) struct ExportGeometry {
    pub canvas_w: u32,
    pub canvas_h: u32,
    pub photo_w: u32,
    pub photo_h: u32,
    pub offset_x: u32,
    pub offset_y: u32,
    pub border_x: u32,
    pub border_y: u32,
}

impl ExportGeometry {
    fn has_border(&self) -> bool {
        self.border_x > 0 || self.border_y > 0
    }

    fn is_identity(&self) -> bool {
        self.canvas_w == self.photo_w && self.canvas_h == self.photo_h
    }
}

pub(crate) fn calculate_resize_target(
    current_w: u32,
    current_h: u32,
    resize_opts: &ResizeOptions,
) -> (u32, u32) {
    if resize_opts.dont_enlarge {
        let exceeds = match resize_opts.mode {
            ResizeMode::LongEdge => current_w.max(current_h) > resize_opts.value,
            ResizeMode::ShortEdge => current_w.min(current_h) > resize_opts.value,
            ResizeMode::Width => current_w > resize_opts.value,
            ResizeMode::Height => current_h > resize_opts.value,
        };
        if !exceeds {
            return (current_w, current_h);
        }
    }

    let fix_width = match resize_opts.mode {
        ResizeMode::LongEdge => current_w >= current_h,
        ResizeMode::ShortEdge => current_w <= current_h,
        ResizeMode::Width => true,
        ResizeMode::Height => false,
    };

    let value = resize_opts.value.max(1);
    if fix_width {
        let h = ((value as f64 * (current_h as f64 / current_w as f64)).round() as u32).max(1);
        (value, h)
    } else {
        let w = ((value as f64 * (current_w as f64 / current_h as f64)).round() as u32).max(1);
        (w, value)
    }
}

fn parse_hex_color(hex: &str) -> Option<[u8; 3]> {
    let raw = hex.trim().trim_start_matches('#');
    let normalized: String = match raw.len() {
        3 => raw.chars().flat_map(|c| [c, c]).collect(),
        6 => raw.to_string(),
        8 => raw[..6].to_string(),
        _ => return None,
    };
    Some([
        u8::from_str_radix(&normalized[0..2], 16).ok()?,
        u8::from_str_radix(&normalized[2..4], 16).ok()?,
        u8::from_str_radix(&normalized[4..6], 16).ok()?,
    ])
}

fn fill_color(hex: Option<&str>) -> [u8; 3] {
    hex.and_then(parse_hex_color).unwrap_or([0, 0, 0])
}

fn resize_target(width: u32, height: u32, resize_opts: Option<&ResizeOptions>) -> (u32, u32) {
    match resize_opts {
        Some(opts) => calculate_resize_target(width, height, opts),
        None => (width, height),
    }
}

fn bordered_size(width: u32, height: u32, border_x: u32, border_y: u32) -> (u32, u32) {
    (
        width.saturating_add(border_x.saturating_mul(2)),
        height.saturating_add(border_y.saturating_mul(2)),
    )
}

fn exceeds_max_dimension(label: &str, width: u32, height: u32) -> bool {
    let exceeds = width > MAX_PAD_DIMENSION || height > MAX_PAD_DIMENSION;
    if exceeds {
        log::warn!(
            "{} {}x{} exceeds the maximum supported dimension; skipping.",
            label,
            width,
            height
        );
    }
    exceeds
}

fn calculate_pad_target(current_w: u32, current_h: u32, pad: &PadOptions) -> Option<(u32, u32)> {
    let ratio_w = pad.ratio_width as f64;
    let ratio_h = pad.ratio_height as f64;
    if !ratio_w.is_finite() || !ratio_h.is_finite() || ratio_w <= 0.0 || ratio_h <= 0.0 {
        return None;
    }

    let target_ratio = ratio_w / ratio_h;
    let original_ratio = current_w as f64 / current_h as f64;
    if (original_ratio - target_ratio).abs() < PAD_RATIO_EPSILON {
        return None;
    }

    let (new_w, new_h) = if original_ratio > target_ratio {
        (current_w, (current_w as f64 / target_ratio).round() as u32)
    } else {
        ((current_h as f64 * target_ratio).round() as u32, current_h)
    };

    let new_w = new_w.max(current_w);
    let new_h = new_h.max(current_h);

    if exceeds_max_dimension("Pad target", new_w, new_h)
        || (new_w == current_w && new_h == current_h)
    {
        return None;
    }

    Some((new_w, new_h))
}

fn calculate_border_thickness(
    src_w: u32,
    src_h: u32,
    border: &BorderOptions,
) -> Option<(u32, u32)> {
    let horizontal = border.horizontal_percent as f64;
    let vertical = border.vertical_percent as f64;
    if !horizontal.is_finite() || !vertical.is_finite() {
        return None;
    }

    if horizontal < 0.0
        || vertical < 0.0
        || horizontal > MAX_BORDER_PERCENT
        || vertical > MAX_BORDER_PERCENT
    {
        log::warn!(
            "Border percentages {}/{} are outside 0..={}; skipping border.",
            horizontal,
            vertical,
            MAX_BORDER_PERCENT
        );
        return None;
    }

    let (basis_x, basis_y) = match border.basis {
        BorderBasis::LongEdge => {
            let edge = src_w.max(src_h) as f64;
            (edge, edge)
        }
        BorderBasis::ShortEdge => {
            let edge = src_w.min(src_h) as f64;
            (edge, edge)
        }
        BorderBasis::EachEdge => (src_w as f64, src_h as f64),
    };

    let border_x = (basis_x * horizontal / 100.0).round() as u32;
    let border_y = (basis_y * vertical / 100.0).round() as u32;

    if border_x == 0 && border_y == 0 {
        return None;
    }

    let (bordered_w, bordered_h) = bordered_size(src_w, src_h, border_x, border_y);
    if exceeds_max_dimension("Bordered size", bordered_w, bordered_h) {
        return None;
    }

    Some((border_x, border_y))
}

fn compute_export_geometry(
    src_w: u32,
    src_h: u32,
    settings: &ExportSettings,
) -> Option<ExportGeometry> {
    if src_w == 0 || src_h == 0 {
        return None;
    }

    let border = settings
        .border
        .as_ref()
        .and_then(|border| calculate_border_thickness(src_w, src_h, border));
    let (border_src_x, border_src_y) = border.unwrap_or((0, 0));
    let (bordered_w, bordered_h) = bordered_size(src_w, src_h, border_src_x, border_src_y);

    let pad_target = settings
        .pad
        .as_ref()
        .and_then(|pad| calculate_pad_target(bordered_w, bordered_h, pad));

    if border.is_none() && pad_target.is_none() {
        return None;
    }

    let (canvas_w, canvas_h) = pad_target.unwrap_or((bordered_w, bordered_h));

    Some(compute_fused_geometry(
        src_w,
        src_h,
        border_src_x,
        border_src_y,
        canvas_w,
        canvas_h,
        settings.resize.as_ref(),
    ))
}

#[allow(clippy::too_many_arguments)]
fn compute_fused_geometry(
    src_w: u32,
    src_h: u32,
    border_src_x: u32,
    border_src_y: u32,
    canvas_w: u32,
    canvas_h: u32,
    resize_opts: Option<&ResizeOptions>,
) -> ExportGeometry {
    let (final_w, final_h) = resize_target(canvas_w, canvas_h, resize_opts);
    let (final_w, final_h) = (final_w.max(1), final_h.max(1));

    let photo_w =
        ((src_w as f64 * final_w as f64 / canvas_w as f64).round() as u32).clamp(1, final_w);
    let photo_h =
        ((src_h as f64 * final_h as f64 / canvas_h as f64).round() as u32).clamp(1, final_h);

    let border_x = ((border_src_x as f64 * final_w as f64 / canvas_w as f64).round() as u32)
        .min(final_w.saturating_sub(photo_w) / 2);
    let border_y = ((border_src_y as f64 * final_h as f64 / canvas_h as f64).round() as u32)
        .min(final_h.saturating_sub(photo_h) / 2);

    ExportGeometry {
        canvas_w: final_w,
        canvas_h: final_h,
        photo_w,
        photo_h,
        offset_x: (final_w - photo_w) / 2,
        offset_y: (final_h - photo_h) / 2,
        border_x,
        border_y,
    }
}

pub(crate) fn compute_export_output_size(
    src_w: u32,
    src_h: u32,
    settings: &ExportSettings,
) -> (u32, u32) {
    match compute_export_geometry(src_w, src_h, settings) {
        Some(geometry) => (geometry.canvas_w, geometry.canvas_h),
        None => resize_target(src_w, src_h, settings.resize.as_ref()),
    }
}

trait FillChannel: image::Primitive {
    fn from_u8(value: u8) -> Self;
}

impl FillChannel for u8 {
    fn from_u8(value: u8) -> Self {
        value
    }
}

impl FillChannel for u16 {
    fn from_u8(value: u8) -> Self {
        value as u16 * 257
    }
}

impl FillChannel for f32 {
    fn from_u8(value: u8) -> Self {
        value as f32 / 255.0
    }
}

trait SolidFill: image::Pixel + 'static {
    fn from_rgb8(color: [u8; 3]) -> Self;
}

impl<T: FillChannel> SolidFill for image::Rgb<T>
where
    image::Rgb<T>: image::Pixel<Subpixel = T> + 'static,
{
    fn from_rgb8([r, g, b]: [u8; 3]) -> Self {
        image::Rgb([T::from_u8(r), T::from_u8(g), T::from_u8(b)])
    }
}

impl<T: FillChannel> SolidFill for image::Rgba<T>
where
    image::Rgba<T>: image::Pixel<Subpixel = T> + 'static,
{
    fn from_rgb8([r, g, b]: [u8; 3]) -> Self {
        image::Rgba([
            T::from_u8(r),
            T::from_u8(g),
            T::from_u8(b),
            T::DEFAULT_MAX_VALUE,
        ])
    }
}

fn fill_border_frame<P>(
    canvas: &mut ImageBuffer<P, Vec<P::Subpixel>>,
    geometry: &ExportGeometry,
    fill: P,
) where
    P: image::Pixel + 'static,
    P::Subpixel: 'static,
{
    let box_x = geometry.offset_x.saturating_sub(geometry.border_x);
    let box_y = geometry.offset_y.saturating_sub(geometry.border_y);
    let box_w = geometry
        .photo_w
        .saturating_add(geometry.border_x.saturating_mul(2));
    let below_photo = geometry.offset_y.saturating_add(geometry.photo_h);
    let right_of_photo = geometry.offset_x.saturating_add(geometry.photo_w);

    let strips = [
        (box_x, box_y, box_w, geometry.border_y),
        (box_x, below_photo, box_w, geometry.border_y),
        (
            box_x,
            geometry.offset_y,
            geometry.border_x,
            geometry.photo_h,
        ),
        (
            right_of_photo,
            geometry.offset_y,
            geometry.border_x,
            geometry.photo_h,
        ),
    ];

    for (x, y, width, height) in strips {
        let x_end = x.saturating_add(width).min(canvas.width());
        let y_end = y.saturating_add(height).min(canvas.height());
        for row in y..y_end {
            for col in x..x_end {
                canvas.put_pixel(col, row, fill);
            }
        }
    }
}

fn place_photo_on_canvas<P>(
    src: &ImageBuffer<P, Vec<P::Subpixel>>,
    geometry: &ExportGeometry,
    outer_fill: P,
    border_fill: Option<P>,
) -> ImageBuffer<P, Vec<P::Subpixel>>
where
    P: image::Pixel + 'static,
    P::Subpixel: 'static,
{
    let mut canvas = ImageBuffer::from_pixel(geometry.canvas_w, geometry.canvas_h, outer_fill);

    if let Some(fill) = border_fill
        && geometry.has_border()
    {
        fill_border_frame(&mut canvas, geometry, fill);
    }

    imageops::replace(
        &mut canvas,
        src,
        geometry.offset_x as i64,
        geometry.offset_y as i64,
    );
    canvas
}

fn compose_image_on_canvas(
    image: &DynamicImage,
    geometry: &ExportGeometry,
    pad_color: [u8; 3],
    border_color: [u8; 3],
) -> DynamicImage {
    fn compose<P: SolidFill>(
        src: &ImageBuffer<P, Vec<P::Subpixel>>,
        geometry: &ExportGeometry,
        pad_color: [u8; 3],
        border_color: [u8; 3],
    ) -> ImageBuffer<P, Vec<P::Subpixel>>
    where
        P::Subpixel: 'static,
    {
        place_photo_on_canvas(
            src,
            geometry,
            P::from_rgb8(pad_color),
            Some(P::from_rgb8(border_color)),
        )
    }

    match image {
        DynamicImage::ImageRgb8(buffer) => {
            DynamicImage::ImageRgb8(compose(buffer, geometry, pad_color, border_color))
        }
        DynamicImage::ImageRgba8(buffer) => {
            DynamicImage::ImageRgba8(compose(buffer, geometry, pad_color, border_color))
        }
        DynamicImage::ImageRgb16(buffer) => {
            DynamicImage::ImageRgb16(compose(buffer, geometry, pad_color, border_color))
        }
        DynamicImage::ImageRgba16(buffer) => {
            DynamicImage::ImageRgba16(compose(buffer, geometry, pad_color, border_color))
        }
        DynamicImage::ImageRgb32F(buffer) => {
            DynamicImage::ImageRgb32F(compose(buffer, geometry, pad_color, border_color))
        }
        DynamicImage::ImageRgba32F(buffer) => {
            DynamicImage::ImageRgba32F(compose(buffer, geometry, pad_color, border_color))
        }
        other => DynamicImage::ImageRgba8(compose(
            &other.to_rgba8(),
            geometry,
            pad_color,
            border_color,
        )),
    }
}

fn relative_dir_is_safe(rel_dir: &Path) -> bool {
    rel_dir.components().all(|component| {
        matches!(
            component,
            std::path::Component::Normal(_) | std::path::Component::CurDir
        )
    })
}

#[cfg(windows)]
fn component_matches(left: std::path::Component<'_>, right: std::path::Component<'_>) -> bool {
    left.as_os_str()
        .to_string_lossy()
        .eq_ignore_ascii_case(&right.as_os_str().to_string_lossy())
}

#[cfg(not(windows))]
fn component_matches(left: std::path::Component<'_>, right: std::path::Component<'_>) -> bool {
    left == right
}

fn strip_prefix_preserving_source_case(source_path: &Path, base_path: &Path) -> Option<PathBuf> {
    let source_components: Vec<_> = source_path.components().collect();
    let base_components: Vec<_> = base_path.components().collect();

    if base_components.len() > source_components.len() {
        return None;
    }

    if !source_components
        .iter()
        .zip(base_components.iter())
        .all(|(source, base)| component_matches(*source, *base))
    {
        return None;
    }

    Some(source_components[base_components.len()..].iter().collect())
}

fn relative_export_dir_for_preserved_folders(
    source_path: &Path,
    base_origin_folders: &[String],
) -> Option<PathBuf> {
    base_origin_folders
        .iter()
        .filter_map(|base| {
            let base_path = Path::new(base);
            strip_prefix_preserving_source_case(source_path, base_path)
                .map(|rel_path| (base_path.components().count(), rel_path))
        })
        .max_by_key(|(component_count, _)| *component_count)
        .and_then(|(_, rel_path)| {
            let rel_dir = rel_path.parent().unwrap_or_else(|| Path::new(""));
            if relative_dir_is_safe(rel_dir) {
                Some(rel_dir.to_path_buf())
            } else {
                None
            }
        })
}

fn apply_export_geometry(
    mut image: DynamicImage,
    export_settings: &ExportSettings,
) -> Result<(DynamicImage, ExportGeometry), String> {
    let (src_w, src_h) = image.dimensions();

    match compute_export_geometry(src_w, src_h, export_settings) {
        None => {
            let (target_w, target_h) = resize_target(src_w, src_h, export_settings.resize.as_ref());
            if target_w != src_w || target_h != src_h {
                image = image.resize_exact(target_w, target_h, imageops::FilterType::Lanczos3);
            }

            let (width, height) = image.dimensions();
            Ok((
                image,
                ExportGeometry {
                    canvas_w: width,
                    canvas_h: height,
                    photo_w: width,
                    photo_h: height,
                    offset_x: 0,
                    offset_y: 0,
                    border_x: 0,
                    border_y: 0,
                },
            ))
        }
        Some(geometry) => {
            if geometry.photo_w != src_w || geometry.photo_h != src_h {
                image = image.resize_exact(
                    geometry.photo_w,
                    geometry.photo_h,
                    imageops::FilterType::Lanczos3,
                );
            }

            let pad_color = fill_color(export_settings.pad.as_ref().map(|pad| pad.color.as_str()));
            let border_color = fill_color(
                export_settings
                    .border
                    .as_ref()
                    .map(|border| border.color.as_str()),
            );

            Ok((
                compose_image_on_canvas(&image, &geometry, pad_color, border_color),
                geometry,
            ))
        }
    }
}

pub(crate) fn apply_export_resize_and_watermark(
    image: DynamicImage,
    settings: &ExportSettings,
) -> Result<DynamicImage, String> {
    apply_export_geometry_and_watermark(image, settings).map(|(image, _)| image)
}

fn apply_export_geometry_and_watermark(
    image: DynamicImage,
    export_settings: &ExportSettings,
) -> Result<(DynamicImage, ExportGeometry), String> {
    let (mut image, geometry) = apply_export_geometry(image, export_settings)?;

    if let Some(watermark_settings) = &export_settings.watermark {
        apply_watermark(&mut image, watermark_settings)?;
    }
    Ok((image, geometry))
}

const FALLBACK_EXPORT_MEMORY: u64 = 4 * 1024 * 1024 * 1024;

fn estimate_export_memory(
    source_path: &str,
    is_raw: bool,
    loaded_dimensions: Option<(u32, u32)>,
    mask_count: usize,
    output_format: &str,
    jpeg_quality: u8,
) -> u64 {
    let pixels = loaded_dimensions
        .map(|(w, h)| w as u64 * h as u64)
        .or_else(|| crate::memory_budget::image_pixel_count(Path::new(source_path), is_raw));

    let Some(pixels) = pixels else {
        return FALLBACK_EXPORT_MEMORY;
    };

    let bytes_per_pixel = if is_raw { 48 } else { 40 }
        + 6 * mask_count.min(crate::image_processing::MAX_MASKS) as u64
        + encoder_bytes_per_pixel(output_format, jpeg_quality);
    pixels * bytes_per_pixel
}

fn encoder_bytes_per_pixel(output_format: &str, jpeg_quality: u8) -> u64 {
    match output_format.to_lowercase().as_str() {
        "jxl" if jpeg_quality == 100 => 90,
        "jxl" => 170,
        _ => 0,
    }
}

fn ensure_export_not_cancelled(cancellation_token: &AtomicBool) -> Result<(), String> {
    if cancellation_token.load(Ordering::SeqCst) {
        Err("Export cancelled".to_string())
    } else {
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ExportCancellationRequest {
    Requested,
    AlreadyRequested,
    NoActiveTask,
}

struct ExportTaskGuard {
    task_token: Arc<Mutex<Option<Arc<AtomicBool>>>>,
    cancellation_token: Arc<AtomicBool>,
    app_handle: Option<tauri::AppHandle>,
}

impl ExportTaskGuard {
    fn new(
        task_token: Arc<Mutex<Option<Arc<AtomicBool>>>>,
        cancellation_token: Arc<AtomicBool>,
    ) -> Self {
        Self {
            task_token,
            cancellation_token,
            app_handle: None,
        }
    }

    fn with_app_handle(
        task_token: Arc<Mutex<Option<Arc<AtomicBool>>>>,
        cancellation_token: Arc<AtomicBool>,
        app_handle: tauri::AppHandle,
    ) -> Self {
        let mut guard = Self::new(task_token, cancellation_token);
        guard.app_handle = Some(app_handle);
        guard
    }
}

fn register_export_task(
    task_token: &Mutex<Option<Arc<AtomicBool>>>,
) -> Result<Arc<AtomicBool>, String> {
    let mut active_token = task_token.lock().unwrap();
    if active_token.is_some() {
        return Err("An export is already in progress.".to_string());
    }

    let cancellation_token = Arc::new(AtomicBool::new(false));
    *active_token = Some(Arc::clone(&cancellation_token));
    Ok(cancellation_token)
}

fn request_export_cancellation<F>(
    task_token: &Mutex<Option<Arc<AtomicBool>>>,
    on_requested: F,
) -> ExportCancellationRequest
where
    F: FnOnce(),
{
    let active_token = task_token.lock().unwrap();
    let Some(cancellation_token) = active_token.as_ref() else {
        return ExportCancellationRequest::NoActiveTask;
    };

    if cancellation_token.swap(true, Ordering::SeqCst) {
        ExportCancellationRequest::AlreadyRequested
    } else {
        on_requested();
        ExportCancellationRequest::Requested
    }
}

fn finish_export_task<F>(
    task_token: &Mutex<Option<Arc<AtomicBool>>>,
    cancellation_token: &Arc<AtomicBool>,
    on_finish: F,
) -> bool
where
    F: FnOnce(bool),
{
    let mut active_token = task_token.lock().unwrap();
    let Some(current_token) = active_token.as_ref() else {
        return false;
    };
    if !Arc::ptr_eq(current_token, cancellation_token) {
        return false;
    }

    let cancelled = cancellation_token.load(Ordering::SeqCst);
    *active_token = None;

    on_finish(cancelled);
    true
}

impl Drop for ExportTaskGuard {
    fn drop(&mut self) {
        let app_handle = self.app_handle.clone();
        let _ = finish_export_task(
            &self.task_token,
            &self.cancellation_token,
            |cancelled| match (cancelled, app_handle) {
                (true, Some(app_handle)) => {
                    let _ = app_handle.emit("export-cancelled", ());
                }
                (false, Some(app_handle)) => {
                    let _ = app_handle.emit("export-error", "Export task terminated unexpectedly");
                }
                _ => {}
            },
        );
    }
}

#[cfg(test)]
#[allow(clippy::too_many_arguments)]
fn render_export_source_masks(
    definitions: &[crate::mask_generation::MaskDefinition],
    base_image: &DynamicImage,
    is_raw: bool,
    adjustments: &Value,
    width: u32,
    height: u32,
    crop_offset: (f32, f32),
    cancellation_token: Option<&AtomicBool>,
) -> Result<Vec<GrayImage>, String> {
    crate::engine_commands::source_masks(
        crate::engine_commands::MaskRequest {
            definitions,
            source: base_image,
            is_raw,
            adjustments,
            dimensions: (width, height),
            scale: 1.0,
            crop_offset,
        },
        || {
            if let Some(token) = cancellation_token {
                ensure_export_not_cancelled(token)
            } else {
                Ok(())
            }
        },
    )
}

#[allow(clippy::too_many_arguments)]
fn process_image_for_export_pipeline(
    path: &str,
    base_image: &DynamicImage,
    js_adjustments: &Value,
    context: &GpuContext,
    state: &tauri::State<AppState>,
    is_raw: bool,
    debug_tag: &str,
    app_handle: &tauri::AppHandle,
    output_precision: RenderOutputPrecision,
) -> Result<DynamicImage, String> {
    let prepared =
        crate::engine_commands::prepare_render_source(base_image, js_adjustments, is_raw)?;

    let tm_override = resolve_tonemapper_override_from_handle(app_handle, is_raw);
    let all_adjustments =
        crate::engine_commands::final_adjustments(js_adjustments, is_raw, tm_override);

    let lut_path = js_adjustments["lutPath"].as_str();
    let lut = lut_path
        .filter(|path| !path.is_empty())
        .map(|path| get_or_load_lut(state, path))
        .transpose()?;

    let unique_hash = calculate_full_job_hash(path, js_adjustments);

    let request = RenderRequest {
        mask_cache_key: None,
        adjustments: all_adjustments,
        mask_bitmaps: &prepared.bitmaps,
        lut,
        roi: None,
    };
    render_export_request(
        context,
        state,
        &prepared.image,
        unique_hash,
        request,
        debug_tag,
        output_precision,
    )
}

#[allow(clippy::too_many_arguments)]
fn render_export_request(
    context: &GpuContext,
    state: &tauri::State<AppState>,
    image: &DynamicImage,
    job_hash: u64,
    request: RenderRequest,
    debug_tag: &str,
    output_precision: RenderOutputPrecision,
) -> Result<DynamicImage, String> {
    crate::engine_commands::render_final(
        context,
        state,
        crate::engine_commands::FinalRenderRequest {
            image,
            native: request,
            precision: output_precision,
            cache_key: job_hash,
            caller: debug_tag,
        },
    )
}

fn render_output_precision(
    output_format: &str,
    export_settings: &ExportSettings,
) -> RenderOutputPrecision {
    crate::engine_commands::export_precision(output_format, export_settings.tiff_bit_depth)
}

fn set_timestamps_from_exif(src: &Path, dst: &Path) {
    let capture_dt = exif_processing::get_creation_date_from_path(src);

    if capture_dt.timestamp() <= 0 {
        let now = filetime::FileTime::now();
        if let Err(e) = filetime::set_file_times(dst, now, now) {
            log::warn!("Could not set timestamps on '{}': {}", dst.display(), e);
        }
        return;
    }

    let ft = filetime::FileTime::from_unix_time(
        capture_dt.timestamp(),
        capture_dt.timestamp_subsec_nanos(),
    );
    if let Err(e) = filetime::set_file_times(dst, ft, ft) {
        log::warn!("Could not set timestamps on '{}': {}", dst.display(), e);
    }
}

fn save_image_with_metadata_and_xmp(
    image: &DynamicImage,
    output_path: &std::path::Path,
    source_path_str: &str,
    export_xmp: &exif_processing::ExportXmp,
    export_settings: &ExportSettings,
) -> Result<(), String> {
    let extension = output_path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase();

    exif_processing::preflight_metadata_retention(
        source_path_str,
        &extension,
        export_settings.keep_metadata,
    )?;

    let format = delivery::canonical_format(&extension);
    let depth = if format == "tiff" {
        export_settings.tiff_bit_depth as u32
    } else if format == "png"
        && matches!(
            image.color(),
            image::ColorType::Rgb16
                | image::ColorType::Rgba16
                | image::ColorType::L16
                | image::ColorType::La16
                | image::ColorType::Rgb32F
                | image::ColorType::Rgba32F
        )
    {
        16
    } else {
        8
    };

    let mut image_bytes = if matches!(format, "png" | "tiff") {
        delivery::encode_profiled_raster_with_density(
            image,
            format,
            depth,
            true,
            export_settings.dpi,
        )?
    } else {
        encode_image_to_bytes(
            image,
            &extension,
            export_settings.jpeg_quality,
            export_settings.tiff_bit_depth,
        )?
    };

    if format == "webp" && export_settings.keep_metadata {
        delivery::normalize_webp_metadata_header(&mut image_bytes, image.dimensions(), true)?;
    }

    exif_processing::write_image_with_metadata(
        &mut image_bytes,
        source_path_str,
        &extension,
        export_settings.keep_metadata,
        export_settings.strip_gps,
        export_xmp,
        export_settings.dpi,
    )?;

    apply_print_density(&mut image_bytes, format, export_settings.dpi);
    if matches!(format, "jpeg" | "webp") {
        delivery::add_profile(&mut image_bytes, format)?;
    }
    if format == "webp" {
        delivery::normalize_webp_metadata_header(&mut image_bytes, image.dimensions(), false)?;
    }
    if delivery::supports_icc(format) {
        delivery::verify_raster_header(&image_bytes, format, image.dimensions(), depth)?;
        if !delivery::verify_profile(&image_bytes, format)? {
            return Err(
                "EXPORT_VERIFICATION_FAILED: sRGB ICC profile is missing or changed".into(),
            );
        }
    }

    #[cfg(target_os = "android")]
    {
        let file_name = output_path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| "Missing Android export file name".to_string())?;
        crate::android_integration::save_image_bytes_to_android_gallery(
            file_name,
            mime_type_for_extension(&extension),
            &image_bytes,
        )?;
    }

    #[cfg(not(target_os = "android"))]
    {
        if let Some(parent) = output_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create folder '{}': {}", parent.display(), e))?;
        }
        fs::write(output_path, image_bytes)
            .map_err(|e| format!("Failed to write file to '{}': {}", output_path.display(), e))?;
    }

    Ok(())
}

#[cfg(target_os = "android")]
pub fn mime_type_for_extension(extension: &str) -> &'static str {
    match extension {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "gif" => "image/gif",
        "tif" | "tiff" => "image/tiff",
        "jxl" => "image/jxl",
        _ => "application/octet-stream",
    }
}

#[allow(clippy::too_many_arguments)]
fn process_image_for_export(
    path: &str,
    base_image: &DynamicImage,
    js_adjustments: &Value,
    export_settings: &ExportSettings,
    context: &GpuContext,
    state: &tauri::State<AppState>,
    is_raw: bool,
    app_handle: &tauri::AppHandle,
    output_format: &str,
) -> Result<DynamicImage, String> {
    let processed_image = process_image_for_export_pipeline(
        path,
        base_image,
        js_adjustments,
        context,
        state,
        is_raw,
        "process_image_for_export",
        app_handle,
        render_output_precision(output_format, export_settings),
    )?;

    apply_export_geometry_and_watermark(processed_image, export_settings).map(|(image, _)| image)
}

fn build_single_mask_adjustments(all: &AllAdjustments, mask_index: usize) -> AllAdjustments {
    let mut single = AllAdjustments {
        global: all.global,
        mask_adjustments: all.mask_adjustments,
        mask_count: 1,
        tile_offset_x: all.tile_offset_x,
        tile_offset_y: all.tile_offset_y,
        mask_atlas_cols: all.mask_atlas_cols,
        ..*all
    };
    single.mask_adjustments[0] = all.mask_adjustments[mask_index];
    for i in 1..single.mask_adjustments.len() {
        single.mask_adjustments[i] = Default::default();
    }
    single
}

fn encode_grayscale_to_png(bitmap: &GrayImage) -> Result<Vec<u8>, String> {
    let mut buf = Vec::new();
    let mut cursor = Cursor::new(&mut buf);
    bitmap
        .write_to(&mut cursor, ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    Ok(buf)
}

#[cfg(feature = "mcp")]
pub(crate) fn jxl_uses_lossless_alpha(image: &DynamicImage, quality: u8) -> bool {
    quality < 100
        && (image.width() > 256 || image.height() > 256)
        && image.color().has_alpha()
        && image.pixels().any(|(_, _, pixel)| pixel[3] != 255)
}

pub(crate) fn encode_image_to_bytes(
    image: &DynamicImage,
    output_format: &str,
    jpeg_quality: u8,
    tiff_bit_depth: TiffBitDepth,
) -> Result<Vec<u8>, String> {
    crate::engine_commands::encode_export(crate::engine_commands::ExportRequest {
        image,
        format: output_format,
        quality: jpeg_quality,
        bit_depth: tiff_bit_depth,
    })
}

pub(crate) fn encode_image_to_bytes_native(
    image: &DynamicImage,
    output_format: &str,
    export_settings: &ExportSettings,
) -> Result<Vec<u8>, String> {
    let jpeg_quality = export_settings.jpeg_quality;
    let mut image_bytes = Vec::new();
    let mut cursor = Cursor::new(&mut image_bytes);

    match output_format.to_lowercase().as_str() {
        "jxl" => {
            let (width, height) = image.dimensions();
            // GPU output uses RGBA even for opaque photos. Do not encode a
            // redundant alpha plane: jxl-encoder 0.3.1's multi-group VarDCT
            // alpha stream cannot be reopened by our native decoder.
            let alpha_pixels = image.color().has_alpha().then(|| image.to_rgba8());
            let has_alpha = alpha_pixels
                .as_ref()
                .is_some_and(|pixels| pixels.pixels().any(|pixel| pixel[3] != 255));

            let lossless_alpha = has_alpha && (width > 256 || height > 256);
            if jpeg_quality < 100 && lossless_alpha {
                log::warn!(
                    "Encoding transparent JPEG XL losslessly: the current encoder's multi-group lossy alpha stream cannot be decoded reliably; the quality setting is not applied."
                );
            }
            let jxl_data = if jpeg_quality == 100 || lossless_alpha {
                // jxl-encoder 0.3.1 also produces invalid multi-group modular
                // lossless streams. Use the small pure-Rust lossless encoder;
                // preserve the existing supported eight-bit JXL output depth.
                use zune_core::{
                    bit_depth::BitDepth, colorspace::ColorSpace, options::EncoderOptions,
                };
                let (pixels, colorspace) = if has_alpha {
                    (
                        Cow::Borrowed(alpha_pixels.as_ref().unwrap().as_raw().as_slice()),
                        ColorSpace::RGBA,
                    )
                } else {
                    (Cow::Owned(image.to_rgb8().into_raw()), ColorSpace::RGB)
                };
                let options = EncoderOptions::new(
                    width as usize,
                    height as usize,
                    colorspace,
                    BitDepth::Eight,
                );
                let mut encoded = Vec::new();
                zune_jpegxl::JxlSimpleEncoder::new(&pixels, options)
                    .encode(&mut encoded)
                    .map_err(|error| format!("Failed to encode lossless JXL: {error:?}"))?;
                encoded
            } else {
                let jxl_quality = calibrated_jxl_quality(jpeg_quality as f32);
                let distance = quality_to_distance(jxl_quality);

                if has_alpha {
                    let rgba = alpha_pixels.as_ref().unwrap();
                    LossyConfig::new(distance)
                        .encode(rgba.as_raw(), width, height, PixelLayout::Rgba8)
                        .map_err(|e| format!("Failed to encode lossy JXL: {}", e))?
                } else {
                    let rgb = image.to_rgb8();
                    LossyConfig::new(distance)
                        .encode(rgb.as_raw(), width, height, PixelLayout::Rgb8)
                        .map_err(|e| format!("Failed to encode lossy JXL: {}", e))?
                }
            };

            return Ok(jxl_data);
        }
        "webp" => {
            let encoder = webp::Encoder::from_image(image)
                .map_err(|_| "Failed to create WebP encoder".to_string())?;
            let webp_mem = encoder.encode(jpeg_quality as f32);
            return Ok(webp_mem.to_vec());
        }
        "jpg" | "jpeg" => {
            let rgb_image = image
                .as_rgb8()
                .map_or_else(|| Cow::Owned(image.to_rgb8()), Cow::Borrowed);
            let mut encoder = JpegEncoder::new_with_quality(&mut cursor, jpeg_quality);
            if let Some(dpi) = export_settings.dpi {
                encoder.set_pixel_density(PixelDensity::dpi(dpi));
            }
            rgb_image
                .write_with_encoder(encoder)
                .map_err(|e| e.to_string())?;
        }
        "png" => {
            let converted;
            let image_to_encode = if image.as_rgb32f().is_some() {
                converted = DynamicImage::ImageRgb16(image.to_rgb16());
                &converted
            } else {
                image
            };

            let encoder = PngEncoder::new(&mut cursor);
            image_to_encode
                .write_with_encoder(encoder)
                .map_err(|e| e.to_string())?;
            if let Some(dpi) = export_settings.dpi {
                insert_png_phys_chunk(&mut image_bytes, dpi);
            }
        }
        "tif" | "tiff" => {
            let (width, height) = image.dimensions();
            let mut encoder = TiffEncoder::new(&mut cursor).map_err(|e| e.to_string())?;
            match export_settings.tiff_bit_depth {
                TiffBitDepth::Eight => write_tiff::<colortype::RGB8, _>(
                    &mut encoder,
                    width,
                    height,
                    image
                        .as_rgb8()
                        .map_or_else(|| Cow::Owned(image.to_rgb8()), Cow::Borrowed)
                        .as_raw(),
                    export_settings.dpi,
                    None,
                )?,
                TiffBitDepth::Sixteen => write_tiff::<colortype::RGB16, _>(
                    &mut encoder,
                    width,
                    height,
                    image
                        .as_rgb16()
                        .map_or_else(|| Cow::Owned(image.to_rgb16()), Cow::Borrowed)
                        .as_raw(),
                    export_settings.dpi,
                    None,
                )?,
            }
        }
        "avif" => {
            image
                .write_to(&mut cursor, image::ImageFormat::Avif)
                .map_err(|e| e.to_string())?;
        }
        _ => return Err(format!("Unsupported file format: {}", output_format)),
    };
    Ok(image_bytes)
}

pub(crate) fn write_tiff<C: colortype::ColorType, W: Write + Seek>(
    encoder: &mut TiffEncoder<W>,
    width: u32,
    height: u32,
    data: &[C::Inner],
    dpi: Option<u16>,
    profile: Option<&[u8]>,
) -> Result<(), String>
where
    [C::Inner]: TiffValue,
{
    let mut image = encoder
        .new_image::<C>(width, height)
        .map_err(|e| e.to_string())?;
    if let Some(dpi) = dpi {
        image.resolution(
            ResolutionUnit::Inch,
            Rational {
                n: dpi.into(),
                d: 1,
            },
        );
    }
    if let Some(profile) = profile {
        image
            .encoder()
            .write_tag(tiff::tags::Tag::Unknown(34675), profile)
            .map_err(|e| e.to_string())?;
    }
    image.write_data(data).map_err(|e| e.to_string())
}

/// Print density is independent of retaining source capture metadata.
pub(crate) fn apply_print_density(bytes: &mut Vec<u8>, format: &str, dpi: Option<u16>) {
    let Some(dpi) = dpi else {
        return;
    };
    match delivery::canonical_format(format) {
        "png" => insert_png_phys_chunk(bytes, dpi),
        "jpeg" => {
            let mut offset = 2;
            while offset + 4 <= bytes.len() && bytes[offset] == 0xff {
                let marker = bytes[offset + 1];
                if marker == 0xda || marker == 0xd9 {
                    break;
                }
                let len = u16::from_be_bytes([bytes[offset + 2], bytes[offset + 3]]) as usize;
                if len < 2 || offset + len + 2 > bytes.len() {
                    break;
                }
                if marker == 0xe0 && len >= 16 && &bytes[offset + 4..offset + 9] == b"JFIF\0" {
                    bytes[offset + 11] = 1;
                    bytes[offset + 12..offset + 14].copy_from_slice(&dpi.to_be_bytes());
                    bytes[offset + 14..offset + 16].copy_from_slice(&dpi.to_be_bytes());
                    return;
                }
                offset += len + 2;
            }
            let mut jfif = vec![0xff, 0xe0, 0, 16, b'J', b'F', b'I', b'F', 0, 1, 2, 1];
            jfif.extend_from_slice(&dpi.to_be_bytes());
            jfif.extend_from_slice(&dpi.to_be_bytes());
            jfif.extend_from_slice(&[0, 0]);
            bytes.splice(2..2, jfif);
        }
        _ => {}
    }
}

fn insert_png_phys_chunk(image_bytes: &mut Vec<u8>, dpi: u16) {
    let mut offset = 8;
    while offset + 12 <= image_bytes.len() {
        let len = u32::from_be_bytes(image_bytes[offset..offset + 4].try_into().unwrap()) as usize;
        let Some(end) = offset
            .checked_add(len)
            .and_then(|n| n.checked_add(12))
            .filter(|end| *end <= image_bytes.len())
        else {
            break;
        };
        if &image_bytes[offset + 4..offset + 8] == b"pHYs" {
            image_bytes.drain(offset..end);
        } else {
            offset = end;
        }
    }
    let pixels_per_meter = (f64::from(dpi) / 0.0254).round() as u32;
    let mut data = Vec::with_capacity(9);
    data.extend_from_slice(&pixels_per_meter.to_be_bytes());
    data.extend_from_slice(&pixels_per_meter.to_be_bytes());
    data.push(1);
    exif_processing::insert_png_chunk(image_bytes, b"pHYs", &data);
}

#[allow(clippy::too_many_arguments)]
fn export_masks_for_image(
    base_image: &DynamicImage,
    js_adjustments: &Value,
    export_settings: &ExportSettings,
    output_path_obj: &std::path::Path,
    source_path_str: &str,
    export_xmp: &exif_processing::ExportXmp,
    context: &Arc<GpuContext>,
    state: &tauri::State<AppState>,
    is_raw: bool,
    app_handle: &tauri::AppHandle,
    cancellation_token: &AtomicBool,
) -> Result<(), String> {
    ensure_export_not_cancelled(cancellation_token)?;
    let prepared = crate::engine_commands::prepare_render_source_checked(
        base_image,
        js_adjustments,
        is_raw,
        || ensure_export_not_cancelled(cancellation_token),
    )?;
    let (img_w, img_h) = prepared.image.dimensions();
    let mask_bitmaps = &prepared.bitmaps;
    ensure_export_not_cancelled(cancellation_token)?;

    if !mask_bitmaps.is_empty() {
        let tm_override = resolve_tonemapper_override_from_handle(app_handle, is_raw);
        let all_adjustments =
            crate::engine_commands::final_adjustments(js_adjustments, is_raw, tm_override);
        let lut_path = js_adjustments["lutPath"].as_str();
        let lut = lut_path
            .filter(|path| !path.is_empty())
            .map(|path| get_or_load_lut(state, path))
            .transpose()?;
        let unique_hash = calculate_full_job_hash(source_path_str, js_adjustments);
        let output_dir = output_path_obj.parent().unwrap_or(output_path_obj);
        let stem = output_path_obj
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("export");
        let extension = output_path_obj
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("jpg");

        for (i, _) in mask_bitmaps.iter().enumerate() {
            ensure_export_not_cancelled(cancellation_token)?;
            let single_adjustments = build_single_mask_adjustments(&all_adjustments, i);
            let full_white_mask = ImageBuffer::from_fn(img_w, img_h, |_, _| Luma([255u8]));
            let single_bitmaps: Vec<ImageBuffer<Luma<u8>, Vec<u8>>> = vec![full_white_mask];

            let processed = render_export_request(
                context,
                state,
                &prepared.image,
                unique_hash,
                RenderRequest {
                    adjustments: single_adjustments,
                    mask_bitmaps: &single_bitmaps,
                    mask_cache_key: None,
                    lut: lut.clone(),
                    roi: None,
                },
                "export_mask_image",
                render_output_precision(extension, export_settings),
            )?;
            ensure_export_not_cancelled(cancellation_token)?;

            let (with_options, geometry) =
                apply_export_geometry_and_watermark(processed, export_settings)?;

            let alpha_scaled = imageops::resize(
                &mask_bitmaps[i],
                geometry.photo_w,
                geometry.photo_h,
                imageops::FilterType::Lanczos3,
            );

            let alpha_resized: GrayImage = if geometry.is_identity() {
                alpha_scaled
            } else {
                place_photo_on_canvas(&alpha_scaled, &geometry, Luma([0u8]), None)
            };
            ensure_export_not_cancelled(cancellation_token)?;

            let mask_image_path =
                output_dir.join(format!("{}_mask_{}_image.{}", stem, i, extension));
            let mask_alpha_path = output_dir.join(format!("{}_mask_{}_alpha.png", stem, i));

            save_image_with_metadata_and_xmp(
                &with_options,
                &mask_image_path,
                source_path_str,
                export_xmp,
                export_settings,
            )?;
            ensure_export_not_cancelled(cancellation_token)?;

            if export_settings.preserve_timestamps {
                set_timestamps_from_exif(Path::new(source_path_str), &mask_image_path);
            }

            let alpha_bytes = encode_grayscale_to_png(&alpha_resized)?;
            ensure_export_not_cancelled(cancellation_token)?;
            #[cfg(target_os = "android")]
            {
                let file_name = mask_alpha_path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .ok_or_else(|| "Missing Android mask export file name".to_string())?;
                crate::android_integration::save_image_bytes_to_android_gallery(
                    file_name,
                    "image/png",
                    &alpha_bytes,
                )?;
            }

            #[cfg(not(target_os = "android"))]
            fs::write(&mask_alpha_path, alpha_bytes).map_err(|e| e.to_string())?;
            ensure_export_not_cancelled(cancellation_token)?;
        }
    }
    Ok(())
}

pub(crate) fn export_adjustments_as_lut(
    js_adjustments: &Value,
    source_path_str: &str,
    context: &Arc<GpuContext>,
    state: &tauri::State<AppState>,
    app_handle: &tauri::AppHandle,
    cancellation_token: &AtomicBool,
) -> Result<Vec<u8>, String> {
    export_adjustments_as_lut_inner(
        js_adjustments,
        source_path_str,
        context,
        state,
        app_handle,
        cancellation_token,
        false,
    )
}

/// Opt-in automation export. Shares LUT semantics with the UI helper while
/// retaining precision through identity sampling, GPU processing and serialization.
#[cfg(feature = "mcp")]
pub(crate) fn export_adjustments_as_lut_high_precision(
    js_adjustments: &Value,
    source_path_str: &str,
    context: &Arc<GpuContext>,
    state: &tauri::State<AppState>,
    app_handle: &tauri::AppHandle,
    cancellation_token: &AtomicBool,
) -> Result<Vec<u8>, String> {
    export_adjustments_as_lut_inner(
        js_adjustments,
        source_path_str,
        context,
        state,
        app_handle,
        cancellation_token,
        true,
    )
}

#[allow(clippy::too_many_arguments)]
fn export_adjustments_as_lut_inner(
    js_adjustments: &Value,
    source_path_str: &str,
    context: &Arc<GpuContext>,
    state: &tauri::State<AppState>,
    app_handle: &tauri::AppHandle,
    cancellation_token: &AtomicBool,
    high_precision: bool,
) -> Result<Vec<u8>, String> {
    ensure_export_not_cancelled(cancellation_token)?;
    let lut_size = 33;
    let identity_image = generate_identity_lut_image(lut_size);

    let render = RenderOptions {
        baseline: BaselineOptions::default(),
        ..resolve_render_options_from_handle(app_handle, false)
    };
    let mut all_adjustments = crate::image_processing::get_all_adjustments_with_render_options(
        js_adjustments,
        false,
        as_shot(source_path_str),
        render,
    );

    all_adjustments.global.show_clipping = 0;
    all_adjustments.global.vignette_amount = 0.0;
    all_adjustments.global.grain_amount = 0.0;
    all_adjustments.global.sharpness = 0.0;
    all_adjustments.global.clarity = 0.0;
    all_adjustments.global.dehaze = 0.0;
    all_adjustments.global.structure = 0.0;
    all_adjustments.global.centré = 0.0;
    all_adjustments.global.glow_amount = 0.0;
    all_adjustments.global.halation_amount = 0.0;
    all_adjustments.global.flare_amount = 0.0;
    all_adjustments.global.luma_noise_reduction = 0.0;
    all_adjustments.global.color_noise_reduction = 0.0;
    all_adjustments.global.chromatic_aberration_red_cyan = 0.0;
    all_adjustments.global.chromatic_aberration_blue_yellow = 0.0;

    let lut_path = js_adjustments["lutPath"].as_str();
    let lut = if high_precision {
        lut_path
            .filter(|p| !p.is_empty())
            .map(|p| get_or_load_lut(state, p))
            .transpose()?
    } else {
        lut_path.and_then(|p| get_or_load_lut(state, p).ok())
    };
    let unique_hash = calculate_full_job_hash(source_path_str, js_adjustments);

    let processed_lut = if high_precision {
        // A cube describes a global color transform; it cannot contain masks.
        all_adjustments.mask_count = 0;
        crate::gpu_processing::process_and_get_dynamic_image_high_precision(
            context,
            &identity_image,
            RenderRequest {
                mask_cache_key: None,
                adjustments: all_adjustments,
                mask_bitmaps: &[],
                lut,
                roi: None,
            },
        )?
    } else {
        process_and_get_dynamic_image(
            context,
            state,
            &identity_image,
            unique_hash,
            RenderRequest {
                mask_cache_key: None,
                adjustments: all_adjustments,
                mask_bitmaps: &[],
                lut,
                roi: None,
            },
            "export_lut",
        )?
    };
    ensure_export_not_cancelled(cancellation_token)?;

    let cube_lut = convert_image_to_cube_lut(&processed_lut, lut_size)?;
    ensure_export_not_cancelled(cancellation_token)?;
    Ok(cube_lut)
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn export_images_impl(
    paths: Vec<String>,
    output_folder_or_file: String,
    is_explicit_file_path: bool,
    base_origin_folders: Vec<String>,
    export_settings: ExportSettings,
    output_format: String,
    adjustments_mode: ExportAdjustmentsMode,
    state: tauri::State<'_, AppState>,
    app_handle: tauri::AppHandle,
    completion_tx: Option<tokio::sync::oneshot::Sender<Result<(), usize>>>,
) -> Result<(), String> {
    let cancellation_token = register_export_task(&state.export_task_token)?;
    *WATERMARK_CACHE.lock().unwrap_or_else(|e| e.into_inner()) = None;
    let task_guard = ExportTaskGuard::with_app_handle(
        Arc::clone(&state.export_task_token),
        Arc::clone(&cancellation_token),
        app_handle.clone(),
    );
    tokio::time::sleep(std::time::Duration::from_millis(10)).await;

    if cancellation_token.load(Ordering::SeqCst) {
        return Ok(());
    }

    let context = match get_or_init_gpu_context(&state, &app_handle) {
        Ok(context) => context,
        Err(_) if cancellation_token.load(Ordering::SeqCst) => return Ok(()),
        Err(error) => return Err(error),
    };

    if cancellation_token.load(Ordering::SeqCst) {
        return Ok(());
    }

    let context = Arc::new(context);
    let progress_counter = Arc::new(AtomicUsize::new(0));

    let available_cores = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(1);

    let mut sys = sysinfo::System::new();
    sys.refresh_memory();

    let app_settings = load_settings(app_handle.clone()).unwrap_or_default();
    let memory_limit = app_settings.export_memory_limit.unwrap_or(80).clamp(25, 95);

    let available_ram = sys.available_memory();
    let available_ram_gb = available_ram as f64 / 1024.0 / 1024.0 / 1024.0;
    let memory_budget = crate::memory_budget::MemoryBudget::new(
        (available_ram as f64 * memory_limit as f64 / 100.0) as u64,
    );

    let num_threads = if paths.len() == 1 {
        1
    } else {
        match app_settings.export_worker_threads {
            Some(threads) if threads > 0 => (threads as usize).clamp(1, 8),
            _ => available_cores.clamp(1, 4),
        }
    };

    log::info!(
        "Batch Export: {} cores, {:.1} GB free RAM -> up to {} threads",
        available_cores,
        available_ram_gb,
        num_threads
    );

    let _export_task = tokio::spawn(async move {
        let _watermark_cache_guard = WatermarkCacheGuard;
        let _task_guard = task_guard;
        let output_folder_path = std::path::Path::new(&output_folder_or_file);
        let total_paths = paths.len();
        let settings = load_settings(app_handle.clone()).unwrap_or_default();

        let mut base_path_counts: HashMap<String, usize> = HashMap::new();
        let mut export_items = Vec::with_capacity(total_paths);

        for (i, path_str) in paths.into_iter().enumerate() {
            let (source_path, _) = parse_virtual_path(&path_str);
            let source_str = source_path.to_string_lossy().to_string();
            let count = base_path_counts.entry(source_str.clone()).or_insert(0);
            *count += 1;

            let mut explicit_vc = None;
            if let Some(idx) = path_str.rfind("vc=") {
                let id_str = path_str[idx + 3..].split('&').next().unwrap_or("");
                if let Ok(id) = id_str.parse::<u32>() {
                    explicit_vc = Some(id);
                }
            }
            if explicit_vc.is_none() {
                let lower = path_str.to_lowercase();
                if let Some(idx) = lower.rfind("_vc") {
                    let id_str: String = lower[idx + 3..]
                        .chars()
                        .take_while(|c| c.is_ascii_digit())
                        .collect();
                    if let Ok(id) = id_str.parse::<u32>() {
                        explicit_vc = Some(id);
                    }
                }
            }
            export_items.push((i, path_str, *count, explicit_vc));
        }

        let used_paths = Arc::new(Mutex::new(std::collections::HashSet::new()));
        let semaphore = Arc::new(tokio::sync::Semaphore::new(num_threads));
        let mut join_handles = Vec::new();

        for (global_index, image_path_str, appearance_count, explicit_vc) in export_items {
            if cancellation_token.load(Ordering::SeqCst) {
                break;
            }
            let permit = semaphore.clone().acquire_owned().await.unwrap();
            if cancellation_token.load(Ordering::SeqCst) {
                drop(permit);
                break;
            }

            let app_handle_clone = app_handle.clone();
            let context_clone = Arc::clone(&context);
            let progress_counter_clone = Arc::clone(&progress_counter);
            let output_folder_path = output_folder_path.to_path_buf();
            let base_origin_folders = base_origin_folders.clone();
            let export_settings = export_settings.clone();
            let output_format = output_format.clone();
            let settings = settings.clone();
            let cancellation_token_clone = Arc::clone(&cancellation_token);
            let adjustments_mode = adjustments_mode.clone();
            let used_paths_clone = Arc::clone(&used_paths);
            let memory_budget = Arc::clone(&memory_budget);

            let handle = tokio::task::spawn_blocking(move || {
                ensure_export_not_cancelled(&cancellation_token_clone)?;

                let state = app_handle_clone.state::<AppState>();
                let (source_path, _) = parse_virtual_path(&image_path_str);
                let export_xmp = exif_processing::ExportXmp::from_metadata(
                    &exif_processing::load_sidecar(&parse_virtual_path(&image_path_str).1),
                );
                let source_path_str = source_path.to_string_lossy().to_string();
                tauri::async_runtime::block_on(crate::immich::ensure_local(
                    &app_handle_clone,
                    &source_path,
                ))?;

                let is_current_edit = adjustments_mode.is_current_edit(&image_path_str);
                if !is_current_edit
                    && matches!(adjustments_mode, ExportAdjustmentsMode::UseSidecars { .. })
                {
                    crate::ai_jobs::ensure_ready(&app_handle_clone, &image_path_str)?;
                }
                let mut js_adjustments = adjustments_mode.adjustments_for(&image_path_str);

                hydrate_adjustments(&state, &mut js_adjustments)?;
                let is_raw = is_raw_file(&source_path_str);
                let original_path = std::path::Path::new(&source_path_str);
                let file_date = exif_processing::get_creation_date_from_path(original_path);

                let filename_template = export_settings
                    .filename_template
                    .as_deref()
                    .unwrap_or("{original_filename}_edited");

                let mut new_stem = generate_filename_from_template(
                    filename_template,
                    original_path,
                    global_index + 1,
                    total_paths,
                    &file_date,
                );

                if let Some(vc_id) = explicit_vc {
                    new_stem = format!("{}_VC{:02}", new_stem, vc_id);
                } else if appearance_count > 1 {
                    new_stem = format!("{}_VC{:02}", new_stem, appearance_count - 1);
                }

                let new_filename = format!("{}.{}", new_stem, output_format);

                let mut output_path =
                    if export_settings.destination_type.as_deref() == Some("originalFolder") {
                        let mut dir = source_path
                            .parent()
                            .unwrap_or(std::path::Path::new(""))
                            .to_path_buf();
                        if let Some(sub) = &export_settings.subfolder {
                            let mut trimmed = sub.trim();

                            while trimmed.starts_with('/') || trimmed.starts_with('\\') {
                                trimmed = &trimmed[1..];
                            }

                            if !trimmed.is_empty() {
                                dir = dir.join(trimmed);
                            }
                        }

                        if let Err(e) = std::fs::create_dir_all(&dir) {
                            return Err(format!(
                                "Failed to create export subdirectory '{}': {}",
                                dir.display(),
                                e
                            ));
                        }

                        dir.join(&new_filename)
                    } else if is_explicit_file_path && total_paths == 1 {
                        output_folder_path.clone()
                    } else if export_settings.preserve_folders {
                        if let Some(rel_dir) = relative_export_dir_for_preserved_folders(
                            source_path.as_path(),
                            &base_origin_folders,
                        ) {
                            let full_dir = output_folder_path.join(rel_dir);
                            if let Err(e) = std::fs::create_dir_all(&full_dir) {
                                return Err(format!(
                                    "Failed to create export subdirectory '{}': {}",
                                    full_dir.display(),
                                    e
                                ));
                            }
                            full_dir.join(&new_filename)
                        } else {
                            output_folder_path.join(&new_filename)
                        }
                    } else {
                        output_folder_path.join(&new_filename)
                    };

                let extension = output_format.to_lowercase();

                if !(is_explicit_file_path && total_paths == 1) {
                    let mut used = used_paths_clone.lock().unwrap();
                    let parent_dir = output_path
                        .parent()
                        .unwrap_or(std::path::Path::new(""))
                        .to_path_buf();
                    let mut counter = 1;

                    while output_path.exists() || used.contains(&output_path) {
                        let incremented_filename =
                            format!("{}_{}.{}", new_stem, counter, extension);
                        output_path = parent_dir.join(&incremented_filename);
                        counter += 1;
                    }
                    used.insert(output_path.clone());
                }

                let result: Result<(), String> = (|| {
                    if extension == "cube" {
                        let cube_bytes = export_adjustments_as_lut(
                            &js_adjustments,
                            &source_path_str,
                            &context_clone,
                            &state,
                            &app_handle_clone,
                            &cancellation_token_clone,
                        )?;
                        ensure_export_not_cancelled(&cancellation_token_clone)?;
                        #[cfg(target_os = "android")]
                        {
                            let file_name = output_path
                                .file_name()
                                .and_then(|name| name.to_str())
                                .ok_or_else(|| "Missing Android LUT file name".to_string())?;
                            crate::android_integration::save_file_bytes_to_android_downloads(
                                file_name,
                                "application/octet-stream",
                                &cube_bytes,
                            )?;
                        }
                        #[cfg(not(target_os = "android"))]
                        fs::write(&output_path, cube_bytes).map_err(|e| e.to_string())?;
                        ensure_export_not_cancelled(&cancellation_token_clone)?;
                        return Ok(());
                    }

                    let loaded_image = if is_current_edit {
                        state
                            .original_image
                            .lock()
                            .unwrap_or_else(|e| e.into_inner())
                            .clone()
                            .filter(|loaded| {
                                parse_virtual_path(&loaded.path).0
                                    == parse_virtual_path(&source_path_str).0
                            })
                    } else {
                        None
                    };

                    let estimated_memory = estimate_export_memory(
                        &source_path_str,
                        is_raw,
                        loaded_image
                            .as_ref()
                            .map(|loaded| (loaded.image.width(), loaded.image.height())),
                        js_adjustments["masks"].as_array().map_or(0, |m| m.len()),
                        &output_format,
                        export_settings.jpeg_quality,
                    );
                    let Some(_export_reservation) =
                        memory_budget.reserve(estimated_memory, Some(&cancellation_token_clone))
                    else {
                        return Err("Export cancelled".to_string());
                    };
                    let Some(_app_reservation) = state
                        .memory_budget
                        .reserve(estimated_memory, Some(&cancellation_token_clone))
                    else {
                        return Err("Export cancelled".to_string());
                    };

                    let cached_patched = loaded_image.as_ref().and_then(|loaded_image| {
                        crate::cached_patched_image(&state, &loaded_image.image, &js_adjustments)
                    });

                    let base_image: Cow<DynamicImage> = if let Some(patched) = &cached_patched {
                        Cow::Borrowed(patched)
                    } else if let Some(loaded_image) = &loaded_image {
                        prepare_base_image_cow(
                            &loaded_image.image,
                            &loaded_image.path,
                            &js_adjustments,
                        )
                        .map_err(|e| format!("Failed to composite AI patches: {}", e))?
                    } else {
                        Cow::Owned(match read_file_mapped(Path::new(&source_path_str)) {
                            Ok(mmap) => load_and_composite(
                                &mmap,
                                &source_path_str,
                                &js_adjustments,
                                false,
                                &settings,
                                None,
                            )
                            .map_err(|e| format!("Failed to load from mmap: {}", e))?,
                            Err(_) => {
                                let bytes =
                                    fs::read(&source_path_str).map_err(|e| e.to_string())?;
                                load_and_composite(
                                    &bytes,
                                    &source_path_str,
                                    &js_adjustments,
                                    false,
                                    &settings,
                                    None,
                                )
                                .map_err(|e| format!("Failed to load from bytes: {}", e))?
                            }
                        })
                    };
                    let mut base_image = Some(base_image);
                    ensure_export_not_cancelled(&cancellation_token_clone)?;

                    let mut main_export_adjustments = js_adjustments.clone();
                    if export_settings.export_masks
                        && let Some(obj) = main_export_adjustments.as_object_mut()
                    {
                        obj.insert("masks".to_string(), serde_json::json!([]));
                    }

                    let actual_output_format = output_path
                        .extension()
                        .and_then(|extension| extension.to_str())
                        .unwrap_or(output_format.as_str());

                    let final_image = process_image_for_export(
                        &source_path_str,
                        base_image.as_ref().unwrap(),
                        &main_export_adjustments,
                        &export_settings,
                        &context_clone,
                        &state,
                        is_raw,
                        &app_handle_clone,
                        actual_output_format,
                    )?;
                    if !export_settings.export_masks {
                        base_image = None;
                    }
                    ensure_export_not_cancelled(&cancellation_token_clone)?;
                    save_image_with_metadata_and_xmp(
                        &final_image,
                        &output_path,
                        &source_path_str,
                        &export_xmp,
                        &export_settings,
                    )?;
                    ensure_export_not_cancelled(&cancellation_token_clone)?;

                    if export_settings.preserve_timestamps {
                        set_timestamps_from_exif(Path::new(&source_path_str), &output_path);
                    }
                    ensure_export_not_cancelled(&cancellation_token_clone)?;

                    if export_settings.export_masks
                        && let Some(base_image) = &base_image
                    {
                        export_masks_for_image(
                            base_image,
                            &js_adjustments,
                            &export_settings,
                            &output_path,
                            &source_path_str,
                            &export_xmp,
                            &context_clone,
                            &state,
                            is_raw,
                            &app_handle_clone,
                            &cancellation_token_clone,
                        )?;
                    }

                    crate::immich::on_exported(&app_handle_clone, &source_path_str, &output_path)
                })();

                if !cancellation_token_clone.load(Ordering::SeqCst) {
                    let current_progress =
                        progress_counter_clone.fetch_add(1, Ordering::SeqCst) + 1;
                    let _ = app_handle_clone.emit(
                        "batch-export-progress",
                        serde_json::json!({
                            "current": current_progress,
                            "total": total_paths,
                            "path": &image_path_str
                        }),
                    );
                }

                drop(permit);
                if cancellation_token_clone.load(Ordering::SeqCst) {
                    Err("Export cancelled".to_string())
                } else {
                    result
                }
            });

            join_handles.push(handle);
        }

        let mut results = Vec::new();
        for handle in join_handles {
            match handle.await {
                Ok(res) => results.push(res),
                Err(e) => results.push(Err(format!("Thread crashed: {}", e))),
            }
        }

        let errors: Vec<String> = results.into_iter().filter_map(Result::err).collect();
        let error_count = errors.len();
        let export_state = app_handle.state::<AppState>();
        let finalized = finish_export_task(
            &export_state.export_task_token,
            &cancellation_token,
            |cancelled| {
                if cancelled {
                    log::info!("Batch export cancelled and worker cleanup completed");
                    let _ = app_handle.emit("export-cancelled", ());
                    return;
                }

                for error in &errors {
                    log::error!("Export error: {}", error);
                    if total_paths == 1 {
                        let _ = app_handle.emit("export-error", error.clone());
                    }
                }

                if error_count > 0 && total_paths > 1 {
                    let _ = app_handle.emit(
                        "export-error",
                        format!("{error_count} of {total_paths} exports failed"),
                    );
                } else if error_count == 0 {
                    let _ = app_handle.emit(
                        "batch-export-progress",
                        serde_json::json!({ "current": total_paths, "total": total_paths, "path": "" }),
                    );
                    let _ = app_handle.emit("export-complete", ());
                }
            },
        );

        if !finalized {
            log::warn!("Ignoring terminal events from a stale export task");
        }

        if let Some(tx) = completion_tx {
            if error_count > 0 {
                let _ = tx.send(Err(error_count));
            } else {
                let _ = tx.send(Ok(()));
            }
        }
    });

    Ok(())
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn export_images(
    paths: Vec<String>,
    output_folder_or_file: String,
    is_explicit_file_path: bool,
    base_origin_folders: Vec<String>,
    export_settings: ExportSettings,
    output_format: String,
    current_edit_path: Option<String>,
    current_edit_adjustments: Option<Value>,
    state: tauri::State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    export_images_impl(
        paths,
        output_folder_or_file,
        is_explicit_file_path,
        base_origin_folders,
        export_settings,
        output_format,
        ExportAdjustmentsMode::UseSidecars {
            active_path: current_edit_path,
            active_adjustments: current_edit_adjustments,
        },
        state,
        app_handle,
        None,
    )
    .await
}

pub async fn run_headless_export(
    session: crate::launch_request::HeadlessExportSession,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    cli_println!("Starting headless export...");
    let state = app_handle.state::<crate::AppState>();

    let source_path = std::path::Path::new(&session.source);
    if !source_path.exists() {
        return Err(format!("Source path does not exist: {}", session.source));
    }

    let mut paths = Vec::new();
    if source_path.is_dir() {
        let images = crate::file_management::list_images_recursive(
            session.source.clone(),
            app_handle.clone(),
        )
        .await?;
        paths = images.into_iter().map(|img| img.path).collect();
    } else {
        paths.push(session.source.clone());
    }

    if paths.is_empty() {
        return Err("No supported images found at the source path.".to_string());
    }

    let output_path = std::path::Path::new(&session.output);
    let is_explicit_file_path =
        paths.len() == 1 && output_path.extension().is_some() && !output_path.is_dir();

    if is_explicit_file_path {
        if let Some(parent) = output_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create output parent directory: {}", e))?;
        }
    } else {
        std::fs::create_dir_all(&session.output)
            .map_err(|e| format!("Failed to create output directory: {}", e))?;
    }

    cli_println!("Found {} images to export. Processing...", paths.len());

    let export_settings = ExportSettings {
        jpeg_quality: session.quality,
        tiff_bit_depth: session.tiff_bit_depth,
        resize: None,
        border: None,
        pad: None,
        keep_metadata: session.keep_metadata,
        preserve_timestamps: true,
        strip_gps: false,
        filename_template: None,
        watermark: None,
        export_masks: false,
        preserve_folders: true,
        destination_type: None,
        subfolder: None,
        dpi: None,
    };

    let mut custom_adjustments = None;
    if let Some(adj_path) = &session.adjustments_override {
        let content = std::fs::read_to_string(adj_path)
            .map_err(|e| format!("Failed to read adjustments file: {}", e))?;
        let json: serde_json::Value = serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse adjustments JSON: {}", e))?;
        custom_adjustments = Some(json);
        cli_println!(
            "Loaded custom adjustments to override sidecars from: {}",
            adj_path
        );
    }

    let (tx, rx) = tokio::sync::oneshot::channel();

    let mode = if let Some(adj) = custom_adjustments {
        ExportAdjustmentsMode::GlobalOverride(adj)
    } else {
        ExportAdjustmentsMode::UseSidecars {
            active_path: None,
            active_adjustments: None,
        }
    };

    export_images_impl(
        paths,
        session.output,
        is_explicit_file_path,
        vec![session.source],
        export_settings,
        session.format,
        mode,
        state.clone(),
        app_handle.clone(),
        Some(tx),
    )
    .await?;

    match rx.await {
        Ok(Ok(())) => Ok(()),
        Ok(Err(errors)) => Err(format!("Export completed with {} errors.", errors)),
        Err(_) => Err("Export task panicked or was cancelled.".to_string()),
    }
}

#[tauri::command]
pub fn cancel_export(
    state: tauri::State<AppState>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    match request_export_cancellation(&state.export_task_token, || {
        let _ = app_handle.emit("export-cancelling", ());
    }) {
        ExportCancellationRequest::Requested => {
            log::info!("Export cancellation requested; workers will stop at the next checkpoint");
        }
        ExportCancellationRequest::AlreadyRequested => {
            log::info!("Export cancellation was already requested");
        }
        ExportCancellationRequest::NoActiveTask => {
            return Err("No export task is currently running.".to_string());
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn estimate_export_sizes(
    paths: Vec<String>,
    export_settings: ExportSettings,
    output_format: String,
    current_edit_path: Option<String>,
    current_edit_adjustments: Option<Value>,
    state: tauri::State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<usize, String> {
    if output_format.to_lowercase() == "cube" {
        return Ok(1_050_000 * paths.len());
    }

    if paths.is_empty() {
        return Ok(0);
    }

    let first_path = &paths[0];
    let (source_path, sidecar_path) = parse_virtual_path(first_path);
    let source_path_str = source_path.to_string_lossy().to_string();

    let context = get_or_init_gpu_context(&state, &app_handle)?;
    let is_current_edit = is_current_edit(first_path, current_edit_path.as_deref());
    let is_raw = is_raw_file(&source_path_str);
    let settings = load_settings(app_handle.clone()).unwrap_or_default();

    let single_image_extrapolated_size: usize = if is_current_edit
        && current_edit_adjustments.is_some()
    {
        let loaded_image = state
            .original_image
            .lock()
            .unwrap()
            .clone()
            .ok_or("No original image loaded")?;
        let mut adjustments_clone = current_edit_adjustments.clone().unwrap();
        hydrate_adjustments(&state, &mut adjustments_clone)?;

        let new_transform_hash = calculate_transform_hash(&adjustments_clone);
        let preview_dim = settings.editor_preview_resolution.unwrap_or(1920);
        let cached = state
            .cached_preview
            .lock()
            .unwrap()
            .get(|cached| {
                cached.transform_hash == new_transform_hash && cached.preview_dim == preview_dim
            })
            .cloned();

        let (preview_image, scale, unscaled_crop_offset) = if let Some(cached) = cached {
            let owned_img = cached.image;
            (owned_img, cached.scale, cached.unscaled_crop_offset)
        } else {
            generate_transformed_preview(&state, &loaded_image, &adjustments_clone, preview_dim)?
        };

        let (img_w, img_h) = preview_image.dimensions();
        let mask_definitions = crate::marigold_surface::render_masks(&adjustments_clone);

        let scaled_crop_offset = (
            unscaled_crop_offset.0 * scale,
            unscaled_crop_offset.1 * scale,
        );

        let mask_source = mask_definitions
            .iter()
            .any(crate::mask_generation::MaskDefinition::requires_warped_image)
            .then(|| composite_patches_on_image(&loaded_image.image, &adjustments_clone))
            .transpose()
            .map_err(|error| error.to_string())?;
        let mask_bitmaps = render_source_mask_bitmaps(
            &mask_definitions,
            mask_source.as_ref(),
            is_raw,
            &adjustments_clone,
            img_w,
            img_h,
            scale,
            scaled_crop_offset,
        )?;

        let render = resolve_render_options_from_handle(&app_handle, is_raw);
        let mut all_adjustments = crate::image_processing::get_all_adjustments_with_render_options(
            &adjustments_clone,
            is_raw,
            loaded_image.as_shot,
            render,
        );
        all_adjustments.global.show_clipping = 0;

        let lut = adjustments_clone["lutPath"]
            .as_str()
            .and_then(|p| get_or_load_lut(&state, p).ok());
        let unique_hash =
            calculate_full_job_hash(&loaded_image.path, &adjustments_clone).wrapping_add(1);

        let processed_preview = process_and_get_dynamic_image_with_precision(
            &context,
            &state,
            &preview_image,
            unique_hash,
            RenderRequest {
                mask_cache_key: None,
                adjustments: all_adjustments,
                mask_bitmaps: &mask_bitmaps,
                lut,
                roi: None,
            },
            "estimate_export_size",
            render_output_precision(&output_format, &export_settings),
        )?;

        let preview_bytes =
            encode_image_to_bytes_native(&processed_preview, &output_format, &export_settings)?;
        let preview_byte_size = preview_bytes.len();

        let (full_w, full_h) = crate::adjustment_utils::transformed_dimensions(
            loaded_image.image.width(),
            loaded_image.image.height(),
            &adjustments_clone,
        );

        let (final_full_w, final_full_h) =
            compute_export_output_size(full_w, full_h, &export_settings);

        let (processed_preview_w, processed_preview_h) = processed_preview.dimensions();
        let pixel_ratio = if processed_preview_w > 0 && processed_preview_h > 0 {
            (final_full_w as f64 * final_full_h as f64)
                / (processed_preview_w as f64 * processed_preview_h as f64)
        } else {
            1.0
        };

        (preview_byte_size as f64 * pixel_ratio) as usize
    } else {
        let metadata = crate::exif_processing::load_sidecar(&sidecar_path);
        let mut js_adjustments = metadata.adjustments;

        const ESTIMATE_DIM: u32 = 1280;

        let file_slice: Vec<u8>;
        let mmap_guard;
        let file_data: &[u8] = match read_file_mapped(Path::new(&source_path_str)) {
            Ok(mmap) => {
                mmap_guard = Some(mmap);
                mmap_guard.as_ref().unwrap()
            }
            Err(_) => {
                file_slice = fs::read(&source_path_str).map_err(|io_err| io_err.to_string())?;
                &file_slice
            }
        };

        let original_image =
            load_base_image_from_bytes(file_data, &source_path_str, true, &settings, None)
                .map_err(|e| e.to_string())?;

        let raw_scale_factor = if is_raw {
            crate::raw_processing::get_fast_demosaic_scale_factor(
                file_data,
                original_image.width(),
                original_image.height(),
            )
        } else {
            1.0
        };

        if let Some(crop_val) = js_adjustments.get_mut("crop")
            && let Ok(c) = serde_json::from_value::<Crop>(crop_val.clone())
        {
            *crop_val = serde_json::to_value(Crop {
                x: c.x * raw_scale_factor as f64,
                y: c.y * raw_scale_factor as f64,
                width: c.width * raw_scale_factor as f64,
                height: c.height * raw_scale_factor as f64,
            })
            .unwrap_or(serde_json::Value::Null);
        }

        let (transformed_shrunk_res, unscaled_crop_offset) =
            apply_all_transformations(Cow::Borrowed(&original_image), &js_adjustments);
        let (shrunk_w, shrunk_h) = transformed_shrunk_res.dimensions();

        let preview_base = if shrunk_w > ESTIMATE_DIM || shrunk_h > ESTIMATE_DIM {
            downscale_f32_image(transformed_shrunk_res.as_ref(), ESTIMATE_DIM, ESTIMATE_DIM)
        } else {
            transformed_shrunk_res.into_owned()
        };

        let (preview_w, preview_h) = preview_base.dimensions();
        let gpu_scale = if shrunk_w > 0 {
            preview_w as f32 / shrunk_w as f32
        } else {
            1.0
        };
        let total_scale = gpu_scale * raw_scale_factor;

        let mask_definitions = crate::marigold_surface::render_masks(&js_adjustments);
        let scaled_crop_offset = (
            unscaled_crop_offset.0 * gpu_scale,
            unscaled_crop_offset.1 * gpu_scale,
        );

        let mask_source = if mask_definitions
            .iter()
            .any(crate::mask_generation::MaskDefinition::requires_warped_image)
        {
            Some(
                load_and_composite(
                    file_data,
                    &source_path_str,
                    &js_adjustments,
                    false,
                    &settings,
                    None,
                )
                .map_err(|error| error.to_string())?,
            )
        } else {
            None
        };
        let mask_bitmaps = render_source_mask_bitmaps(
            &mask_definitions,
            mask_source.as_ref(),
            is_raw,
            &js_adjustments,
            preview_w,
            preview_h,
            total_scale,
            scaled_crop_offset,
        )?;

        let render = resolve_render_options_from_handle(&app_handle, is_raw);
        let mut all_adjustments = crate::image_processing::get_all_adjustments_with_render_options(
            &js_adjustments,
            is_raw,
            as_shot(&source_path_str),
            render,
        );
        all_adjustments.global.show_clipping = 0;

        let lut = js_adjustments["lutPath"]
            .as_str()
            .and_then(|p| get_or_load_lut(&state, p).ok());
        let unique_hash =
            calculate_full_job_hash(&source_path_str, &js_adjustments).wrapping_add(1);

        let processed_preview = process_and_get_dynamic_image_with_precision(
            &context,
            &state,
            &preview_base,
            unique_hash,
            RenderRequest {
                mask_cache_key: None,
                adjustments: all_adjustments,
                mask_bitmaps: &mask_bitmaps,
                lut,
                roi: None,
            },
            "estimate_batch_export_size",
            render_output_precision(&output_format, &export_settings),
        )?;

        let preview_bytes =
            encode_image_to_bytes_native(&processed_preview, &output_format, &export_settings)?;
        let single_image_estimated_size = preview_bytes.len();

        let full_w = (shrunk_w as f32 / raw_scale_factor).round() as u32;
        let full_h = (shrunk_h as f32 / raw_scale_factor).round() as u32;

        let (final_full_w, final_full_h) =
            compute_export_output_size(full_w, full_h, &export_settings);

        let (processed_preview_w, processed_preview_h) = processed_preview.dimensions();
        let pixel_ratio = if processed_preview_w > 0 && processed_preview_h > 0 {
            (final_full_w as f64 * final_full_h as f64)
                / (processed_preview_w as f64 * processed_preview_h as f64)
        } else {
            1.0
        };

        (single_image_estimated_size as f64 * pixel_ratio) as usize
    };

    Ok(single_image_extrapolated_size * paths.len())
}

#[cfg(test)]
mod source_mask_export_tests {
    use super::*;
    use serde_json::json;

    fn settings(keep_metadata: bool, strip_gps: bool) -> ExportSettings {
        ExportSettings {
            dpi: None,
            pad: None,
            border: None,
            jpeg_quality: 92,
            tiff_bit_depth: TiffBitDepth::Sixteen,
            resize: None,
            keep_metadata,
            preserve_timestamps: false,
            strip_gps,
            filename_template: None,
            watermark: None,
            export_masks: false,
            preserve_folders: false,
            destination_type: None,
            subfolder: None,
        }
    }

    #[test]
    fn desktop_print_density_survives_disabling_capture_metadata() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source.jpg");
        DynamicImage::new_rgb8(16, 8).save(&source).unwrap();
        let image = DynamicImage::ImageRgb16(ImageBuffer::from_fn(16, 8, |x, y| {
            image::Rgb([(x * 937) as u16, (y * 1877) as u16, 32123])
        }));
        let mut options = settings(false, true);
        options.dpi = Some(300);
        for format in ["jpeg", "png", "tiff"] {
            let output = dir.path().join(format!("print.{format}"));
            save_image_with_metadata(&image, &output, source.to_str().unwrap(), &options).unwrap();
            let bytes = fs::read(&output).unwrap();
            assert!(delivery::verify_profile(&bytes, format).unwrap());
            assert_eq!(
                image::load_from_memory(&bytes).unwrap().dimensions(),
                (16, 8)
            );
            match format {
                "jpeg" => {
                    let jfif = bytes.windows(5).position(|part| part == b"JFIF\0").unwrap();
                    assert_eq!(bytes[jfif + 7], 1);
                    assert_eq!(&bytes[jfif + 8..jfif + 12], &[1, 44, 1, 44]);
                }
                "png" => {
                    let phys = bytes.windows(4).position(|part| part == b"pHYs").unwrap();
                    assert_eq!(
                        u32::from_be_bytes(bytes[phys + 4..phys + 8].try_into().unwrap()),
                        11811
                    );
                    assert_eq!(bytes[phys + 12], 1);
                }
                "tiff" => {
                    let mut decoder = tiff::decoder::Decoder::new(Cursor::new(&bytes)).unwrap();
                    assert_eq!(
                        decoder.get_tag(tiff::tags::Tag::XResolution).unwrap(),
                        tiff::decoder::ifd::Value::Rational(300, 1)
                    );
                    assert_eq!(
                        decoder.get_tag(tiff::tags::Tag::YResolution).unwrap(),
                        tiff::decoder::ifd::Value::Rational(300, 1)
                    );
                }
                _ => unreachable!(),
            }
        }
    }

    #[test]
    fn desktop_export_roundtrips_capture_metadata_gps_and_srgb_profile() {
        use little_exif::{
            exif_tag::ExifTag, filetype::FileExtension, metadata::Metadata, rational::uR64,
        };
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source.jpg");
        let source_image = DynamicImage::new_rgb8(32, 16);
        let mut bytes =
            encode_image_to_bytes(&source_image, "jpeg", 92, TiffBitDepth::Eight).unwrap();
        let mut metadata = Metadata::new();
        metadata.set_tag(ExifTag::Copyright("Example author".into()));
        metadata.set_tag(ExifTag::GPSLatitude(vec![uR64 {
            nominator: 22,
            denominator: 1,
        }]));
        metadata.set_tag(ExifTag::GPSLatitudeRef("N".into()));
        metadata
            .write_to_vec(&mut bytes, FileExtension::JPEG)
            .unwrap();
        fs::write(&source, bytes).unwrap();
        let output_image = DynamicImage::new_rgb8(16, 8);
        for (name, keep, strip) in [
            ("kept.jpg", true, false),
            ("stripped.jpg", true, true),
            ("off.jpg", false, true),
        ] {
            let output = dir.path().join(name);
            save_image_with_metadata(
                &output_image,
                &output,
                source.to_str().unwrap(),
                &settings(keep, strip),
            )
            .unwrap();
            let bytes = fs::read(&output).unwrap();
            assert!(delivery::verify_profile(&bytes, "jpg").unwrap());
            delivery::verify_raster_header(&bytes, "jpg", (16, 8), 8).unwrap();
            let exif = exif::Reader::new().read_from_container(&mut Cursor::new(&bytes));
            if keep {
                let exif = exif.unwrap();
                assert!(
                    exif.get_field(exif::Tag::Copyright, exif::In::PRIMARY)
                        .is_some()
                );
                assert_eq!(
                    exif.get_field(exif::Tag::GPSLatitude, exif::In::PRIMARY)
                        .is_some(),
                    !strip
                );
                assert_eq!(
                    exif.get_field(exif::Tag::Orientation, exif::In::PRIMARY)
                        .and_then(|field| field.value.get_uint(0)),
                    Some(1)
                );
            } else if let Ok(exif) = exif {
                assert!(
                    exif.get_field(exif::Tag::Copyright, exif::In::PRIMARY)
                        .is_none()
                );
                assert!(
                    exif.get_field(exif::Tag::GPSLatitude, exif::In::PRIMARY)
                        .is_none()
                );
            }
        }
        let rejected = dir.path().join("rejected.tif");
        assert!(
            save_image_with_metadata(
                &output_image,
                &rejected,
                source.to_str().unwrap(),
                &settings(true, true),
            )
            .unwrap_err()
            .contains("UNSUPPORTED_METADATA")
        );
        assert!(!rejected.exists());
        let tiff = dir.path().join("without-capture.tif");
        save_image_with_metadata(
            &output_image,
            &tiff,
            source.to_str().unwrap(),
            &settings(false, true),
        )
        .unwrap();
        assert!(delivery::verify_profile(&fs::read(&tiff).unwrap(), "tif").unwrap());
        assert!(
            exif_processing::preflight_metadata_retention(tiff.to_str().unwrap(), "png", true,)
                .is_err()
        );
    }

    #[test]
    fn sixteen_bit_resize_and_watermark_keep_sub_eight_bit_levels() {
        let dir = tempfile::tempdir().unwrap();
        let watermark = dir.path().join("mark.png");
        DynamicImage::ImageRgba8(image::ImageBuffer::from_pixel(
            2,
            2,
            image::Rgba([255, 0, 0, 255]),
        ))
        .save(&watermark)
        .unwrap();
        let source = DynamicImage::ImageRgba16(image::ImageBuffer::from_fn(2048, 64, |x, _| {
            image::Rgba([20000 + x as u16, 30000, 40000, 65535])
        }));
        let mut options = settings(false, true);
        options.resize = Some(ResizeOptions {
            mode: ResizeMode::Width,
            value: 1024,
            dont_enlarge: true,
        });
        options.watermark = Some(WatermarkSettings {
            path: watermark.to_string_lossy().into_owned(),
            anchor: WatermarkAnchor::TopLeft,
            scale: 25.0,
            spacing: 0.0,
            opacity: 50.0,
        });
        let mut baseline_options = options.clone();
        baseline_options.watermark = None;
        let baseline = apply_export_resize_and_watermark(source.clone(), &baseline_options)
            .unwrap()
            .to_rgba16();
        let resized = apply_export_resize_and_watermark(source, &options).unwrap();
        assert_eq!(resized.dimensions(), (1024, 32));
        assert_eq!(resized.color(), image::ColorType::Rgba16);
        let watermark_footprint = (8, 8);
        assert!(watermark_footprint.0 > 0 && watermark_footprint.1 > 0);
        assert!(watermark_footprint.0 < resized.width());
        assert!(watermark_footprint.1 < resized.height());
        let covered = (2, 2);
        let outside = (watermark_footprint.0 + 2, 2);
        let composited = resized.to_rgba16();
        let base_pixel = baseline.get_pixel(covered.0, covered.1);
        let covered_pixel = composited.get_pixel(covered.0, covered.1);
        let overlay_alpha = 32768_u32;
        let expected_red = ((65535 * overlay_alpha
            + u32::from(base_pixel[0]) * (65535 - overlay_alpha))
            / 65535) as u16;
        let expected_green = (u32::from(base_pixel[1]) * (65535 - overlay_alpha) / 65535) as u16;
        assert_ne!(
            covered_pixel, base_pixel,
            "watermark must change covered pixels"
        );
        assert!(covered_pixel[0].abs_diff(expected_red) <= 2);
        assert!(covered_pixel[1].abs_diff(expected_green) <= 2);
        assert_ne!(
            composited.get_pixel(watermark_footprint.0 - 1, watermark_footprint.1 - 1),
            baseline.get_pixel(watermark_footprint.0 - 1, watermark_footprint.1 - 1)
        );
        assert_eq!(
            composited.get_pixel(watermark_footprint.0, watermark_footprint.1 - 1),
            baseline.get_pixel(watermark_footprint.0, watermark_footprint.1 - 1)
        );
        assert_eq!(
            composited.get_pixel(watermark_footprint.0 - 1, watermark_footprint.1),
            baseline.get_pixel(watermark_footprint.0 - 1, watermark_footprint.1)
        );
        assert_eq!(
            composited.get_pixel(outside.0, outside.1),
            baseline.get_pixel(outside.0, outside.1)
        );
        let tiff = dir.path().join("gradient.tiff");
        save_image_with_metadata(&resized, &tiff, "unused", &options).unwrap();
        let decoded = image::open(&tiff).unwrap();
        assert_eq!(decoded.color(), image::ColorType::Rgb16);
        let reopened = decoded.to_rgb16();
        assert_eq!((reopened.width(), reopened.height()), (1024, 32));
        for channel in 0..3 {
            assert_eq!(
                reopened.get_pixel(covered.0, covered.1)[channel],
                covered_pixel[channel]
            );
            assert_eq!(
                reopened.get_pixel(outside.0, outside.1)[channel],
                baseline.get_pixel(outside.0, outside.1)[channel]
            );
        }
        assert!(
            (0..watermark_footprint.0)
                .any(|x| !reopened.get_pixel(x, covered.1)[0].is_multiple_of(257)),
            "composited pixels must retain values beyond eight-bit expansion"
        );
        let levels: std::collections::HashSet<u16> =
            (100..1000).map(|x| reopened.get_pixel(x, 2)[0]).collect();
        assert!(
            levels.len() > 256,
            "only {} ramp levels survived",
            levels.len()
        );
        assert!(
            levels.iter().any(|level| !level.is_multiple_of(257)),
            "protected ramp must retain values beyond eight-bit expansion"
        );
    }

    #[test]
    fn desktop_png_webp_and_eight_bit_tiff_verify_profile_and_alpha() {
        let dir = tempfile::tempdir().unwrap();
        let source = DynamicImage::ImageRgba8(image::ImageBuffer::from_fn(20, 10, |x, _| {
            image::Rgba([25, 80, 120, if x < 10 { 90 } else { 255 }])
        }));
        let mut options = settings(false, true);
        options.tiff_bit_depth = TiffBitDepth::Eight;
        for extension in ["png", "webp", "tif"] {
            let path = dir.path().join(format!("alpha.{extension}"));
            save_image_with_metadata(&source, &path, "unused", &options).unwrap();
            let bytes = fs::read(&path).unwrap();
            assert!(delivery::verify_profile(&bytes, extension).unwrap());
            delivery::verify_raster_header(&bytes, extension, (20, 10), 8).unwrap();
            if extension != "tif" {
                assert_eq!(
                    image::load_from_memory(&bytes)
                        .unwrap()
                        .to_rgba8()
                        .get_pixel(0, 0)[3],
                    90
                );
            }
        }
    }

    #[test]
    fn export_source_masks_follow_batch_image_and_keep_cancellation() {
        let adjustments = json!({
            "masks": [{
                "id": "mask", "name": "Color", "visible": true, "invert": false,
                "adjustments": {},
                "subMasks": [{
                    "id": "color", "type": "color", "visible": true,
                    "mode": "additive",
                    "parameters": {"targetX": 1, "targetY": 1, "tolerance": 20, "grow": 0, "feather": 0}
                }]
            }]
        });
        let definitions = crate::marigold_surface::render_masks(&adjustments);
        let first = DynamicImage::ImageRgb8(image::RgbImage::from_fn(8, 4, |x, _| {
            if x < 4 {
                image::Rgb([255, 0, 0])
            } else {
                image::Rgb([0, 0, 255])
            }
        }));
        let second =
            DynamicImage::ImageRgb8(image::RgbImage::from_pixel(8, 4, image::Rgb([0, 255, 0])));
        let cancellation = AtomicBool::new(false);
        let render = |source: &DynamicImage| {
            render_export_source_masks(
                &definitions,
                source,
                false,
                &adjustments,
                8,
                4,
                (0.0, 0.0),
                Some(&cancellation),
            )
        };
        let first_mask = render(&first).unwrap().remove(0);
        let second_mask = render(&second).unwrap().remove(0);
        assert_eq!(first_mask.get_pixel(6, 1)[0], 0);
        assert!(second_mask.get_pixel(6, 1)[0] > 0);

        cancellation.store(true, Ordering::SeqCst);
        assert_eq!(render(&second).unwrap_err(), "Export cancelled");
    }
}

#[cfg(test)]
fn save_image_with_metadata(
    image: &DynamicImage,
    path: &Path,
    source: &str,
    settings: &ExportSettings,
) -> Result<(), String> {
    save_image_with_metadata_and_xmp(
        image,
        path,
        source,
        &exif_processing::ExportXmp::from_metadata(&Default::default()),
        settings,
    )
}

pub(crate) fn encode_native_with_options(
    image: &DynamicImage,
    format: &str,
    quality: u8,
    depth: TiffBitDepth,
    dpi: Option<u16>,
) -> Result<Vec<u8>, String> {
    let options = ExportSettings {
        jpeg_quality: quality,
        tiff_bit_depth: depth,
        dpi,
        resize: None,
        border: None,
        pad: None,
        keep_metadata: false,
        preserve_timestamps: false,
        strip_gps: true,
        filename_template: None,
        watermark: None,
        export_masks: false,
        preserve_folders: false,
        destination_type: None,
        subfolder: None,
    };
    encode_image_to_bytes_native(image, format, &options)
}
