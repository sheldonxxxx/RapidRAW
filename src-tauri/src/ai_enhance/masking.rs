//! Local, learned mask refinement and semantic selections.
//!
//! ViTMatte consumes normalized RGB and a trimap; it never replaces known
//! foreground/background. Native-resolution inference only visits boundary tiles.
//! Semantic inputs follow the upstream UperNet/BiSeNet 512px RGB processors.

use anyhow::{Result, anyhow, bail, ensure};
use image::{DynamicImage, GenericImageView, GrayImage, Luma, RgbImage, imageops::FilterType};
use ndarray::{Array4, ArrayViewD};
use ort::{session::Session, value::Tensor};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct MattingOptions {
    /// Zero processes native pixels; otherwise limits the working image's long edge.
    pub max_edge: u32,
    pub tile_size: u32,
    pub overlap: u32,
    /// Unknown band radius in source-image pixels, scaled with the working image.
    pub radius: u32,
}

impl Default for MattingOptions {
    fn default() -> Self {
        Self {
            max_edge: 1536,
            tile_size: 512,
            overlap: 64,
            radius: 32,
        }
    }
}

#[derive(Debug, Default, Serialize)]
pub struct MattingStatistics {
    pub inferred_tiles: usize,
    pub coarse_fallback_tiles: usize,
}

impl MattingOptions {
    pub fn validate(&self) -> Result<()> {
        ensure!(
            self.max_edge == 0 || (128..=8192).contains(&self.max_edge),
            "AI_MATTING_OPTIONS: max_edge must be 0 or 128..8192"
        );
        ensure!(
            (128..=1024).contains(&self.tile_size) && self.tile_size.is_multiple_of(32),
            "AI_MATTING_OPTIONS: tile_size must be a multiple of 32 in 128..1024"
        );
        ensure!(
            self.overlap >= 16 && self.overlap < self.tile_size / 2,
            "AI_MATTING_OPTIONS: overlap must be at least 16 and less than half the tile size"
        );
        ensure!(
            (1..=256).contains(&self.radius),
            "AI_MATTING_OPTIONS: radius must be 1..256"
        );
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SemanticModel {
    Landscape,
    Face,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct SemanticOptions {
    pub kind: SemanticModel,
    pub classes: Vec<String>,
    /// Minimum summed probability of selected labels. A winning selected label
    /// is also required, so a weak match cannot fog the whole photograph.
    pub confidence: f32,
    /// Pixel-space [x,y,width,height]. Useful for small faces in group photographs.
    pub region: Option<[u32; 4]>,
}

impl Default for SemanticOptions {
    fn default() -> Self {
        Self {
            kind: SemanticModel::Landscape,
            classes: vec!["vegetation".into()],
            confidence: 0.25,
            region: None,
        }
    }
}

pub const LANDSCAPE_CATEGORIES: &[&str] = &[
    "vegetation",
    "water",
    "sky",
    "building",
    "mountain",
    "ground",
    "person",
    "animal",
];
pub const FACE_CATEGORIES: &[&str] = &[
    "skin", "hair", "eyes", "brows", "lips", "nose", "neck", "clothing", "ears",
];

impl SemanticOptions {
    pub fn validate(&self) -> Result<Vec<usize>> {
        ensure!(
            self.confidence.is_finite() && (0.0..=1.0).contains(&self.confidence),
            "AI_SEMANTIC_OPTIONS: confidence must be finite and within 0..1"
        );
        ensure!(
            !self.classes.is_empty() && self.classes.len() <= 32,
            "AI_SEMANTIC_OPTIONS: select between 1 and 32 categories"
        );
        let mut ids = Vec::new();
        for category in &self.classes {
            let name = category.trim().to_ascii_lowercase();
            let group: &[usize] = match (self.kind, name.as_str()) {
                (SemanticModel::Landscape, "vegetation") => &[4, 9, 17, 29, 66, 72],
                (SemanticModel::Landscape, "water") => &[21, 26, 60, 109, 113, 128],
                (SemanticModel::Landscape, "building" | "architecture") => {
                    &[0, 1, 25, 48, 61, 79, 84]
                }
                (SemanticModel::Landscape, "mountain") => &[16, 68],
                (SemanticModel::Landscape, "ground") => &[3, 6, 11, 13, 34, 46, 52, 91, 94],
                (SemanticModel::Face, "skin") => &[1, 7, 8, 10, 14],
                (SemanticModel::Face, "hair") => &[17],
                (SemanticModel::Face, "eyes") => &[4, 5],
                (SemanticModel::Face, "brows") => &[2, 3],
                (SemanticModel::Face, "lips") => &[12, 13],
                (SemanticModel::Face, "nose") => &[10],
                (SemanticModel::Face, "neck") => &[14],
                (SemanticModel::Face, "clothing") => &[16],
                (SemanticModel::Face, "ears") => &[7, 8],
                (SemanticModel::Landscape, _) => {
                    let id = ADE_LABELS
                        .iter()
                        .position(|label| *label == name)
                        .ok_or_else(|| {
                            anyhow!("AI_SEMANTIC_CLASS: unknown landscape category '{category}'")
                        })?;
                    ids.push(id);
                    &[]
                }
                _ => bail!("AI_SEMANTIC_CLASS: unknown face category '{category}'"),
            };
            ids.extend_from_slice(group);
        }
        ids.sort_unstable();
        ids.dedup();
        Ok(ids)
    }
}

fn cancelled(cancel: &AtomicBool) -> Result<()> {
    ensure!(!cancel.load(Ordering::Relaxed), "AI_ENHANCE_CANCELLED");
    Ok(())
}

fn validate_image(width: u32, height: u32) -> Result<()> {
    ensure!(
        width > 0 && height > 0 && u64::from(width) * u64::from(height) <= 120_000_000,
        "AI_MASK_IMAGE: image must contain 1..120000000 pixels"
    );
    Ok(())
}

pub fn working_dimensions(width: u32, height: u32, max_edge: u32) -> (u32, u32) {
    if max_edge == 0 || width.max(height) <= max_edge {
        return (width, height);
    }
    let scale = max_edge as f64 / width.max(height) as f64;
    (
        ((width as f64 * scale).round() as u32).max(1),
        ((height as f64 * scale).round() as u32).max(1),
    )
}

/// Erode thresholded foreground/background in linear time without a full-size
/// integral image; the intermediate uses two bytes per pixel.
fn all_neighbours(mask: &GrayImage, radius: u32, foreground: bool) -> Vec<bool> {
    let (width, height) = mask.dimensions();
    let (w, h, r) = (width as usize, height as usize, radius as usize);
    let valid = |v: u8| if foreground { v >= 240 } else { v <= 15 };
    let mut horizontal = vec![0u16; w * h];
    for y in 0..h {
        let row = &mask.as_raw()[y * w..(y + 1) * w];
        let mut sum: u16 = row[..(r + 1).min(w)].iter().filter(|&&v| valid(v)).count() as u16;
        for x in 0..w {
            horizontal[y * w + x] = sum;
            if x >= r {
                sum -= u16::from(valid(row[x - r]));
            }
            if x + r + 1 < w {
                sum += u16::from(valid(row[x + r + 1]));
            }
        }
    }
    let mut result = vec![false; w * h];
    for x in 0..w {
        let mut sum: u32 = (0..(r + 1).min(h))
            .map(|y| u32::from(horizontal[y * w + x]))
            .sum();
        let horizontal_area = (x + r + 1).min(w) - x.saturating_sub(r);
        for y in 0..h {
            let area = horizontal_area * ((y + r + 1).min(h) - y.saturating_sub(r));
            result[y * w + x] = sum as usize == area;
            if y >= r {
                sum -= u32::from(horizontal[(y - r) * w + x]);
            }
            if y + r + 1 < h {
                sum += u32::from(horizontal[(y + r + 1) * w + x]);
            }
        }
    }
    result
}

pub fn make_trimap(mask: &GrayImage, radius: u32) -> Result<GrayImage> {
    validate_image(mask.width(), mask.height())?;
    ensure!(
        (1..=256).contains(&radius),
        "AI_MATTING_OPTIONS: radius must be 1..256"
    );
    let foreground = all_neighbours(mask, radius, true);
    let background = all_neighbours(mask, radius, false);
    let bytes = foreground
        .iter()
        .zip(background)
        .map(|(&fg, bg)| {
            if fg {
                255
            } else if bg {
                0
            } else {
                128
            }
        })
        .collect();
    GrayImage::from_raw(mask.width(), mask.height(), bytes)
        .ok_or_else(|| anyhow!("AI_MATTING_TRIMAP"))
}

fn image_tensor(rgb: &RgbImage, trimap: Option<&GrayImage>) -> Array4<f32> {
    let channels = if trimap.is_some() { 4 } else { 3 };
    let width = rgb.width() as usize;
    let height = rgb.height() as usize;
    let padded_width = width.div_ceil(32) * 32;
    let padded_height = height.div_ceil(32) * 32;
    let mut data = Array4::zeros((1, channels, padded_height, padded_width));
    let mean = if trimap.is_some() {
        [0.5; 3]
    } else {
        [0.485, 0.456, 0.406]
    };
    let std = if trimap.is_some() {
        [0.5; 3]
    } else {
        [0.229, 0.224, 0.225]
    };
    for (x, y, pixel) in rgb.enumerate_pixels() {
        for c in 0..3 {
            data[[0, c, y as usize, x as usize]] = (pixel[c] as f32 / 255.0 - mean[c]) / std[c];
        }
        if let Some(trimap) = trimap {
            data[[0, 3, y as usize, x as usize]] = match trimap.get_pixel(x, y)[0] {
                0 => 0.0,
                255 => 1.0,
                _ => 128.0 / 255.0,
            };
        }
    }
    data
}

fn alpha_from_output(output: ArrayViewD<'_, f32>, width: u32, height: u32) -> Result<GrayImage> {
    let shape = output.shape();
    ensure!(
        shape.len() == 4
            && shape[0] == 1
            && shape[1] == 1
            && shape[2] >= height as usize
            && shape[3] >= width as usize,
        "AI_MATTING_OUTPUT: expected [1,1,H,W] alpha matching the padded input"
    );
    let mut alpha = GrayImage::new(width, height);
    for (x, y, pixel) in alpha.enumerate_pixels_mut() {
        let value = output[[0, 0, y as usize, x as usize]];
        ensure!(value.is_finite(), "AI_MATTING_OUTPUT: non-finite alpha");
        pixel[0] = (value.clamp(0.0, 1.0) * 255.0).round() as u8;
    }
    Ok(alpha)
}

fn validate_trimap_context(trimap: &GrayImage) -> Result<()> {
    if trimap.pixels().any(|pixel| pixel[0] == 128) {
        ensure!(
            trimap.pixels().any(|pixel| pixel[0] == 0)
                && trimap.pixels().any(|pixel| pixel[0] == 255),
            "AI_MATTING_TRIMAP: Refinement needs known foreground and background; reduce the boundary radius or expand the selected area"
        );
    }
    Ok(())
}

fn feather(position: u32, start: u32, end: u32, length: u32, blend: u32) -> f32 {
    let leading = if start == 0 {
        1.0
    } else {
        ((position - start) as f32 + 0.5) / blend as f32
    };
    let trailing = if end == length {
        1.0
    } else {
        ((end - position) as f32 - 0.5) / blend as f32
    };
    leading.min(trailing).min(1.0)
}

fn tile_starts(length: u32, tile_size: u32, overlap: u32) -> Vec<u32> {
    let last = length.saturating_sub(tile_size);
    let stride = tile_size - 2 * overlap;
    let mut starts = vec![0];
    while *starts.last().unwrap() < last {
        starts.push((starts.last().unwrap() + stride).min(last));
    }
    starts
}

/// Only one tile row of floating-point sums is resident, even for native masks.
/// Rows are finalized before the next tile row can reuse their ring-buffer slots.
struct AlphaRows {
    width: u32,
    rows: u32,
    next: u32,
    sums: Vec<f32>,
    weights: Vec<f32>,
}

impl AlphaRows {
    fn new(width: u32, height: u32, tile_size: u32) -> Result<Self> {
        let rows = height.min(tile_size);
        let count = width as usize * rows as usize;
        let allocate = || -> Result<Vec<f32>> {
            let mut values = Vec::new();
            values.try_reserve_exact(count).map_err(|_| {
                anyhow!("AI_MATTING_MEMORY_LIMIT: Cannot allocate tile blending rows")
            })?;
            values.resize(count, 0.0);
            Ok(values)
        };
        Ok(Self {
            width,
            rows,
            next: 0,
            sums: allocate()?,
            weights: allocate()?,
        })
    }

    fn index(&self, x: u32, y: u32) -> usize {
        (y % self.rows) as usize * self.width as usize + x as usize
    }

    fn finish(
        &mut self,
        until: u32,
        trimap: &GrayImage,
        result: &mut GrayImage,
        cancel: &AtomicBool,
    ) -> Result<()> {
        for y in self.next..until {
            if y % 32 == 0 {
                cancelled(cancel)?;
            }
            for x in 0..self.width {
                let at = self.index(x, y);
                if trimap.get_pixel(x, y)[0] == 128 {
                    ensure!(
                        self.weights[at] > 0.0,
                        "AI_MATTING_OUTPUT: Uncovered unknown pixel"
                    );
                    result.put_pixel(
                        x,
                        y,
                        Luma([(self.sums[at] / self.weights[at]).round() as u8]),
                    );
                }
                self.sums[at] = 0.0;
                self.weights[at] = 0.0;
            }
        }
        self.next = until;
        Ok(())
    }
}

fn tiled_alpha(
    rgb: &RgbImage,
    trimap: &GrayImage,
    coarse: &GrayImage,
    options: &MattingOptions,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(f32),
    mut predict: impl FnMut(&RgbImage, &GrayImage) -> Result<GrayImage>,
) -> Result<(GrayImage, MattingStatistics)> {
    let (width, height) = rgb.dimensions();
    let mut tiles = Vec::new();
    // Shift edge tiles inward instead of truncating their context. A shortened
    // corner tile can lose the trimap's only known foreground anchor.
    for top in tile_starts(height, options.tile_size, options.overlap) {
        for left in tile_starts(width, options.tile_size, options.overlap) {
            let right = (left + options.tile_size).min(width);
            let bottom = (top + options.tile_size).min(height);
            if (top..bottom).any(|yy| (left..right).any(|xx| trimap.get_pixel(xx, yy)[0] == 128)) {
                tiles.push((left, top, right, bottom));
            }
        }
    }
    let mut result = trimap.clone();
    let mut statistics = MattingStatistics::default();
    if tiles.is_empty() {
        return Ok((result, statistics));
    }
    let mut blend = AlphaRows::new(width, height, options.tile_size)?;
    progress(0.0);
    for (index, &(left, top, right, bottom)) in tiles.iter().enumerate() {
        cancelled(cancel)?;
        blend.finish(top, trimap, &mut result, cancel)?;
        let tile = image::imageops::crop_imm(rgb, left, top, right - left, bottom - top).to_image();
        let tri =
            image::imageops::crop_imm(trimap, left, top, right - left, bottom - top).to_image();
        let has_foreground = tri.pixels().any(|pixel| pixel[0] == 255);
        let has_background = tri.pixels().any(|pixel| pixel[0] == 0);
        let alpha = if has_foreground && has_background {
            statistics.inferred_tiles += 1;
            predict(&tile, &tri)?
        } else {
            // A local trimap without both anchors is underconstrained. Keep the
            // existing alpha there instead of inventing an opaque/empty block.
            statistics.coarse_fallback_tiles += 1;
            image::imageops::crop_imm(coarse, left, top, right - left, bottom - top).to_image()
        };
        ensure!(
            alpha.dimensions() == tile.dimensions(),
            "AI_MATTING_OUTPUT: Tile dimensions differ"
        );
        cancelled(cancel)?;
        for y in top..bottom {
            if y % 32 == 0 {
                cancelled(cancel)?;
            }
            let wy = feather(y, top, bottom, height, options.overlap * 2);
            for x in left..right {
                if trimap.get_pixel(x, y)[0] == 128 {
                    let weight = wy * feather(x, left, right, width, options.overlap * 2);
                    let at = blend.index(x, y);
                    blend.sums[at] += weight * f32::from(alpha.get_pixel(x - left, y - top)[0]);
                    blend.weights[at] += weight;
                }
            }
        }
        progress((index + 1) as f32 / tiles.len() as f32);
    }
    blend.finish(height, trimap, &mut result, cancel)?;
    Ok((result, statistics))
}

/// Predict alpha inside the unknown band. Neighboring context predictions
/// crossfade there; known foreground/background remain exact trimap constraints.
pub fn refine(
    session: &mut Session,
    image: &DynamicImage,
    mask: &GrayImage,
    options: &MattingOptions,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(f32),
) -> Result<(GrayImage, MattingStatistics)> {
    options.validate()?;
    let (width, height) = image.dimensions();
    validate_image(width, height)?;
    ensure!(
        mask.dimensions() == (width, height),
        "AI_MATTING_MASK: mask and photograph dimensions must match"
    );
    cancelled(cancel)?;
    let (work_w, work_h) = working_dimensions(width, height, options.max_edge);
    let rgb = image
        .resize_exact(work_w, work_h, FilterType::Triangle)
        .to_rgb8();
    let coarse = image::imageops::resize(mask, work_w, work_h, FilterType::Triangle);
    let radius = ((options.radius as f32 * work_w as f32 / width as f32).round() as u32).max(1);
    let trimap = make_trimap(&coarse, radius)?;
    validate_trimap_context(&trimap)?;
    let (mut result, statistics) = tiled_alpha(
        &rgb,
        &trimap,
        &coarse,
        options,
        cancel,
        progress,
        |tile, tri| {
            let tensor = Tensor::from_array(image_tensor(tile, Some(tri)))?;
            let outputs = session.run(ort::inputs![tensor])?;
            alpha_from_output(
                outputs[0].try_extract_array::<f32>()?,
                tile.width(),
                tile.height(),
            )
        },
    )?;
    cancelled(cancel)?;
    if (work_w, work_h) != (width, height) {
        result = image::imageops::resize(&result, width, height, FilterType::Triangle);
        // Reapply source-pixel constraints after interpolation.
        let original_trimap = make_trimap(mask, options.radius)?;
        for (pixel, constraint) in result.pixels_mut().zip(original_trimap.pixels()) {
            if constraint[0] != 128 {
                *pixel = *constraint;
            }
        }
    }
    progress(1.0);
    Ok((result, statistics))
}

fn semantic_from_logits(
    output: ArrayViewD<'_, f32>,
    ids: &[usize],
    confidence: f32,
    classes: usize,
) -> Result<GrayImage> {
    let shape = output.shape();
    ensure!(
        shape.len() == 4 && shape[0] == 1 && shape[1] == classes && shape[2] > 0 && shape[3] > 0,
        "AI_SEMANTIC_OUTPUT: expected [1,{classes},H,W] logits"
    );
    let (h, w) = (shape[2], shape[3]);
    ensure!(
        h <= 2048 && w <= 2048,
        "AI_SEMANTIC_OUTPUT: oversized logits"
    );
    let mut selected = vec![false; classes];
    for &id in ids {
        ensure!(
            id < classes,
            "AI_SEMANTIC_CLASS: label outside model vocabulary"
        );
        selected[id] = true;
    }
    let mut mask = GrayImage::new(w as u32, h as u32);
    for y in 0..h {
        for x in 0..w {
            let mut winner = 0;
            let mut max = f32::NEG_INFINITY;
            for c in 0..classes {
                let value = output[[0, c, y, x]];
                ensure!(value.is_finite(), "AI_SEMANTIC_OUTPUT: non-finite logits");
                if value > max {
                    max = value;
                    winner = c;
                }
            }
            if !selected[winner] {
                continue;
            }
            let (mut sum, mut chosen) = (0.0, 0.0);
            for c in 0..classes {
                let p = (output[[0, c, y, x]] - max).exp();
                sum += p;
                if selected[c] {
                    chosen += p;
                }
            }
            let probability = chosen / sum;
            if probability >= confidence {
                mask.put_pixel(
                    x as u32,
                    y as u32,
                    Luma([(probability * 255.0).round() as u8]),
                );
            }
        }
    }
    Ok(mask)
}

pub fn semantic(
    session: &mut Session,
    image: &DynamicImage,
    options: &SemanticOptions,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(f32),
) -> Result<GrayImage> {
    let ids = options.validate()?;
    let (width, height) = image.dimensions();
    validate_image(width, height)?;
    cancelled(cancel)?;
    let [x, y, w, h] = options.region.unwrap_or([0, 0, width, height]);
    ensure!(
        w > 0
            && h > 0
            && x.checked_add(w).is_some_and(|v| v <= width)
            && y.checked_add(h).is_some_and(|v| v <= height),
        "AI_SEMANTIC_REGION: region must lie within the photograph"
    );
    let crop = image
        .crop_imm(x, y, w, h)
        .resize_exact(512, 512, FilterType::Triangle)
        .to_rgb8();
    let tensor = Tensor::from_array(image_tensor(&crop, None))?;
    progress(0.1);
    cancelled(cancel)?;
    let outputs = session.run(ort::inputs![tensor])?;
    cancelled(cancel)?;
    let classes = if options.kind == SemanticModel::Landscape {
        150
    } else {
        19
    };
    let mask = semantic_from_logits(
        outputs[0].try_extract_array::<f32>()?,
        &ids,
        options.confidence,
        classes,
    )?;
    let mask = image::imageops::resize(&mask, w, h, FilterType::Triangle);
    let mut result = GrayImage::new(width, height);
    image::imageops::replace(&mut result, &mask, x as i64, y as i64);
    progress(1.0);
    Ok(result)
}

// ADE20K labels in the upstream openmmlab/upernet-convnext-tiny config.json.
pub const ADE_LABELS: [&str; 150] = [
    "wall",
    "building",
    "sky",
    "floor",
    "tree",
    "ceiling",
    "road",
    "bed",
    "windowpane",
    "grass",
    "cabinet",
    "sidewalk",
    "person",
    "earth",
    "door",
    "table",
    "mountain",
    "plant",
    "curtain",
    "chair",
    "car",
    "water",
    "painting",
    "sofa",
    "shelf",
    "house",
    "sea",
    "mirror",
    "rug",
    "field",
    "armchair",
    "seat",
    "fence",
    "desk",
    "rock",
    "wardrobe",
    "lamp",
    "bathtub",
    "railing",
    "cushion",
    "base",
    "box",
    "column",
    "signboard",
    "chest of drawers",
    "counter",
    "sand",
    "sink",
    "skyscraper",
    "fireplace",
    "refrigerator",
    "grandstand",
    "path",
    "stairs",
    "runway",
    "case",
    "pool table",
    "pillow",
    "screen door",
    "stairway",
    "river",
    "bridge",
    "bookcase",
    "blind",
    "coffee table",
    "toilet",
    "flower",
    "book",
    "hill",
    "bench",
    "countertop",
    "stove",
    "palm",
    "kitchen island",
    "computer",
    "swivel chair",
    "boat",
    "bar",
    "arcade machine",
    "hovel",
    "bus",
    "towel",
    "light",
    "truck",
    "tower",
    "chandelier",
    "awning",
    "streetlight",
    "booth",
    "television receiver",
    "airplane",
    "dirt track",
    "apparel",
    "pole",
    "land",
    "bannister",
    "escalator",
    "ottoman",
    "bottle",
    "buffet",
    "poster",
    "stage",
    "van",
    "ship",
    "fountain",
    "conveyer belt",
    "canopy",
    "washer",
    "plaything",
    "swimming pool",
    "stool",
    "barrel",
    "basket",
    "waterfall",
    "tent",
    "bag",
    "minibike",
    "cradle",
    "oven",
    "ball",
    "food",
    "step",
    "tank",
    "trade name",
    "microwave",
    "pot",
    "animal",
    "bicycle",
    "lake",
    "dishwasher",
    "screen",
    "blanket",
    "sculpture",
    "hood",
    "sconce",
    "vase",
    "traffic light",
    "tray",
    "ashcan",
    "fan",
    "pier",
    "crt screen",
    "plate",
    "monitor",
    "bulletin board",
    "shower",
    "radiator",
    "glass",
    "clock",
    "flag",
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tiled_alpha_normalizes_overlap_and_reuses_rows_without_losing_constraints() {
        let options = MattingOptions {
            tile_size: 768,
            ..Default::default()
        };
        for (width, height) in [(23, 11), (769, 3), (1291, 1777)] {
            let rgb = RgbImage::from_fn(width, height, |x, y| {
                image::Rgb([((x * 3 + y * 7) % 256) as u8, 0, 0])
            });
            let trimap = GrayImage::from_fn(width, height, |x, y| {
                Luma([match (x + y) % 19 {
                    0 => 0,
                    1 => 255,
                    _ => 128,
                }])
            });
            let (result, _) = tiled_alpha(
                &rgb,
                &trimap,
                &trimap,
                &options,
                &AtomicBool::new(false),
                &mut |_| {},
                |tile, _| {
                    Ok(GrayImage::from_fn(tile.width(), tile.height(), |x, y| {
                        Luma([tile.get_pixel(x, y)[0]])
                    }))
                },
            )
            .unwrap();
            for (x, y, pixel) in result.enumerate_pixels() {
                let known = trimap.get_pixel(x, y)[0];
                assert_eq!(
                    pixel[0],
                    if known == 128 {
                        rgb.get_pixel(x, y)[0]
                    } else {
                        known
                    }
                );
            }
        }
    }

    #[test]
    fn context_disagreement_crossfades_across_both_native_core_boundaries() {
        let options = MattingOptions {
            tile_size: 768,
            ..Default::default()
        };
        let rgb = RgbImage::new(1403, 1411);
        let trimap = GrayImage::from_fn(1403, 1411, |x, y| {
            Luma([match (x % 64, y % 64) {
                (0, 3) => 0,
                (1, 3) => 255,
                _ => 128,
            }])
        });
        let mut predictions = 0;
        let (result, _) = tiled_alpha(
            &rgb,
            &trimap,
            &trimap,
            &options,
            &AtomicBool::new(false),
            &mut |_| {},
            |tile, _| {
                predictions += 1;
                Ok(GrayImage::from_pixel(
                    tile.width(),
                    tile.height(),
                    Luma([if predictions == 1 { 80 } else { 200 }]),
                ))
            },
        )
        .unwrap();
        // Conflicting local predictions must not become a hard 120-level jump
        // across the middle of overlapping native context tiles.
        for ((ax, ay), (bx, by)) in [
            ((703, 100), (704, 100)),
            ((100, 703), (100, 704)),
            ((703, 703), (704, 704)),
        ] {
            let a = result.get_pixel(ax, ay)[0];
            let b = result.get_pixel(bx, by)[0];
            assert!(a.abs_diff(b) <= 2, "Context seam at {ax},{ay}: {a} -> {b}");
            assert!((100..190).contains(&a));
        }
    }

    #[test]
    fn corner_tiles_keep_full_context_and_known_foreground_anchors() {
        let options = MattingOptions {
            tile_size: 768,
            ..Default::default()
        };
        let rgb = RgbImage::new(2048, 2048);
        let trimap = GrayImage::from_fn(2048, 2048, |x, y| {
            Luma([if x >= 720 && y >= 720 {
                255
            } else if x < 20 || y < 20 {
                0
            } else {
                128
            }])
        });
        let mut predictions = 0;
        tiled_alpha(
            &rgb,
            &trimap,
            &trimap,
            &options,
            &AtomicBool::new(false),
            &mut |_| {},
            |tile, tri| {
                predictions += 1;
                assert_eq!(tile.dimensions(), (768, 768));
                assert!(
                    tri.pixels().any(|pixel| pixel[0] == 255),
                    "Truncating a corner context removed its known foreground"
                );
                Ok(GrayImage::from_pixel(
                    tile.width(),
                    tile.height(),
                    Luma([200]),
                ))
            },
        )
        .unwrap();
        assert!(predictions > 1);
    }

    #[test]
    fn underconstrained_local_tiles_preserve_coarse_alpha_and_report_fallback() {
        let options = MattingOptions::default();
        let rgb = RgbImage::new(111, 97);
        let coarse = GrayImage::from_fn(111, 97, |x, y| Luma([((x * 3 + y * 7) % 256) as u8]));
        for known in [0, 128, 255] {
            let trimap =
                GrayImage::from_fn(111, 97, |x, _| Luma([if x < 20 { known } else { 128 }]));
            let (result, statistics) = tiled_alpha(
                &rgb,
                &trimap,
                &coarse,
                &options,
                &AtomicBool::new(false),
                &mut |_| {},
                |_, _| panic!("An underconstrained tile must not enter ViTMatte"),
            )
            .unwrap();
            assert_eq!(statistics.inferred_tiles, 0);
            assert_eq!(statistics.coarse_fallback_tiles, 1);
            for (x, y, pixel) in result.enumerate_pixels() {
                let constraint = trimap.get_pixel(x, y)[0];
                assert_eq!(
                    pixel[0],
                    if constraint == 128 {
                        coarse.get_pixel(x, y)[0]
                    } else {
                        constraint
                    }
                );
            }
            assert!(validate_trimap_context(&trimap).is_err());
        }
        assert!(validate_trimap_context(&GrayImage::from_pixel(1, 1, Luma([255]))).is_ok());
        assert!(
            validate_trimap_context(&GrayImage::from_raw(3, 1, vec![0, 128, 255]).unwrap()).is_ok()
        );
    }

    #[test]
    fn trimap_has_unknown_band_and_preserves_interiors() {
        let mask = GrayImage::from_fn(11, 9, |x, _| Luma([if x >= 5 { 255 } else { 0 }]));
        let tri = make_trimap(&mask, 2).unwrap();
        for y in 0..9 {
            for x in 0..11 {
                assert_eq!(
                    tri.get_pixel(x, y)[0],
                    if x < 3 {
                        0
                    } else if x < 7 {
                        128
                    } else {
                        255
                    }
                );
            }
        }
    }

    #[test]
    fn uncertain_mask_is_unknown_even_without_binary_boundary() {
        let mask = GrayImage::from_pixel(3, 3, Luma([128]));
        assert!(
            make_trimap(&mask, 256)
                .unwrap()
                .pixels()
                .all(|p| p[0] == 128)
        );
    }

    #[test]
    fn linear_trimap_matches_brute_force_at_corners_and_on_soft_edges() {
        let mask = GrayImage::from_fn(13, 8, |x, y| {
            Luma([match (x * 11 + y * 7) % 7 {
                0 => 128,
                1..=3 => 255,
                _ => 0,
            }])
        });
        for radius in [1, 2, 8, 16] {
            let tri = make_trimap(&mask, radius).unwrap();
            for y in 0..mask.height() {
                for x in 0..mask.width() {
                    let mut fg = true;
                    let mut bg = true;
                    for yy in y.saturating_sub(radius)..(y + radius + 1).min(mask.height()) {
                        for xx in x.saturating_sub(radius)..(x + radius + 1).min(mask.width()) {
                            fg &= mask.get_pixel(xx, yy)[0] >= 240;
                            bg &= mask.get_pixel(xx, yy)[0] <= 15;
                        }
                    }
                    assert_eq!(
                        tri.get_pixel(x, y)[0],
                        if fg {
                            255
                        } else if bg {
                            0
                        } else {
                            128
                        }
                    );
                }
            }
        }
    }

    #[test]
    fn tensor_matches_vitmatte_processor_and_pads_only_bottom_right() {
        let rgb = RgbImage::from_pixel(1, 1, image::Rgb([0, 128, 255]));
        let trimap = GrayImage::from_pixel(1, 1, Luma([128]));
        let tensor = image_tensor(&rgb, Some(&trimap));
        assert_eq!(tensor.shape(), &[1, 4, 32, 32]);
        assert_eq!(tensor[[0, 0, 0, 0]], -1.0);
        assert_eq!(tensor[[0, 2, 0, 0]], 1.0);
        assert_eq!(tensor[[0, 3, 0, 0]], 128.0 / 255.0);
        assert_eq!(tensor[[0, 3, 1, 1]], 0.0);
    }

    #[test]
    fn category_unions_use_actual_model_label_ids() {
        let options = SemanticOptions {
            classes: vec!["water".into(), "sky".into()],
            ..Default::default()
        };
        assert_eq!(
            options.validate().unwrap(),
            vec![2, 21, 26, 60, 109, 113, 128]
        );
        let options = SemanticOptions {
            kind: SemanticModel::Face,
            classes: vec!["eyes".into(), "hair".into()],
            ..Default::default()
        };
        assert_eq!(options.validate().unwrap(), vec![4, 5, 17]);
    }

    #[test]
    fn semantic_rejects_unselected_winners_and_non_finite_output() {
        let mut logits = Array4::zeros((1, 3, 1, 2));
        logits[[0, 1, 0, 0]] = 5.0;
        logits[[0, 2, 0, 1]] = 5.0;
        let mask = semantic_from_logits(logits.view().into_dyn(), &[1], 0.1, 3).unwrap();
        assert!(mask.get_pixel(0, 0)[0] > 250);
        assert_eq!(mask.get_pixel(1, 0)[0], 0);
        logits[[0, 0, 0, 1]] = f32::NAN;
        assert!(semantic_from_logits(logits.view().into_dyn(), &[1], 0.1, 3).is_err());
    }

    #[test]
    fn invalid_model_output_and_options_fail_before_writes() {
        let alpha = Array4::from_elem((1, 1, 2, 2), f32::NAN);
        assert!(alpha_from_output(alpha.view().into_dyn(), 2, 2).is_err());
        assert!(
            MattingOptions {
                overlap: 256,
                ..Default::default()
            }
            .validate()
            .is_err()
        );
        assert!(
            SemanticOptions {
                confidence: f32::NAN,
                ..Default::default()
            }
            .validate()
            .is_err()
        );
        assert!(
            SemanticOptions {
                classes: vec!["unsupported".into()],
                ..Default::default()
            }
            .validate()
            .is_err()
        );
        assert_eq!(working_dimensions(6000, 4000, 1536), (1536, 1024));
        assert_eq!(working_dimensions(6000, 4000, 0), (6000, 4000));
        assert!(cancelled(&AtomicBool::new(true)).is_err());
    }
}
