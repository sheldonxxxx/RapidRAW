//! Advisory edit measurements. The edit is compared with an aligned reference that
//! keeps the same framing and retouching but default tone and colour and no local
//! masks. Numbers describe the rendered photograph; they are not aesthetic scores.
//! `look_here` entries point at places worth inspecting: an edge band brighter or
//! darker than the surroundings would explain, or similar-looking pixels treated
//! very differently. Either can be intended.
use super::comparison::{GEOMETRY_KEYS, bounded_response, image_block};
use super::*;
use rayon::prelude::*;

const EPS: f32 = 1e-4;
/// ln(2)/2: half a stop. Similar pixels whose treatment differs by more are reported.
const TREATMENT_THRESHOLD: f32 = std::f32::consts::LN_2 / 2.0;
const MAX_REPORTS: usize = 6;
/// ln(1.22): edge sectors whose rim differs from the reference relationship by more.
const RIM_THRESHOLD: f64 = 0.2;
const MAX_RIM_REPORTS: usize = 4;

#[derive(Clone)]
struct Plane {
    width: usize,
    height: usize,
    data: Vec<f32>,
}

impl Plane {
    fn at(&self, x: usize, y: usize) -> f32 {
        self.data[y * self.width + x]
    }
}

struct Linear {
    r: Plane,
    g: Plane,
    b: Plane,
    luminance: Plane,
}

fn to_linear(v: f32) -> f32 {
    if v <= 0.04045 {
        v / 12.92
    } else {
        ((v + 0.055) / 1.055).powf(2.4)
    }
}

fn linear(image: &DynamicImage) -> Linear {
    let rgb = image.to_rgb32f();
    let (width, height) = (rgb.width() as usize, rgb.height() as usize);
    let channel = |c: usize| Plane {
        width,
        height,
        data: rgb
            .pixels()
            .map(|p| to_linear(p[c].clamp(0.0, 1.0)))
            .collect(),
    };
    let (r, g, b) = (channel(0), channel(1), channel(2));
    let luminance = Plane {
        width,
        height,
        data: (0..r.data.len())
            .map(|i| 0.2126 * r.data[i] + 0.7152 * g.data[i] + 0.0722 * b.data[i])
            .collect(),
    };
    Linear { r, g, b, luminance }
}

fn weighted_mean(values: &Plane, weights: &[f32]) -> Option<f64> {
    let (mut sum, mut total) = (0.0f64, 0.0f64);
    for (v, w) in values.data.iter().zip(weights) {
        sum += f64::from(*v) * f64::from(*w);
        total += f64::from(*w);
    }
    (total > 1.0).then(|| sum / total)
}

fn box_mean(values: &Plane, x0: usize, y0: usize, x1: usize, y1: usize) -> f64 {
    let mut sum = 0.0f64;
    for y in y0..y1 {
        for x in x0..x1 {
            sum += f64::from(values.at(x, y));
        }
    }
    sum / ((x1 - x0) * (y1 - y0)).max(1) as f64
}

/// Square dilation of a binary mask, separable.
fn dilate(mask: &[bool], width: usize, height: usize, radius: usize) -> Vec<bool> {
    let mut rows = vec![false; mask.len()];
    for y in 0..height {
        for x in 0..width {
            let lo = x.saturating_sub(radius);
            let hi = (x + radius).min(width - 1);
            rows[y * width + x] = (lo..=hi).any(|i| mask[y * width + i]);
        }
    }
    let mut out = vec![false; mask.len()];
    for y in 0..height {
        let lo = y.saturating_sub(radius);
        let hi = (y + radius).min(height - 1);
        for x in 0..width {
            out[y * width + x] = (lo..=hi).any(|j| rows[j * width + x]);
        }
    }
    out
}

struct Bands {
    inside: Vec<f32>,
    near: Vec<bool>,
    surround: Vec<bool>,
    far: Vec<bool>,
}

fn bands(mask: &GrayImage, edge: usize) -> Bands {
    let (width, height) = (mask.width() as usize, mask.height() as usize);
    let solid: Vec<bool> = mask.pixels().map(|p| p[0] >= 128).collect();
    let d1 = dilate(&solid, width, height, edge);
    let d2 = dilate(&solid, width, height, edge * 2);
    let d4 = dilate(&d2, width, height, edge * 2);
    Bands {
        inside: mask.pixels().map(|p| f32::from(p[0]) / 255.0).collect(),
        near: (0..solid.len()).map(|i| d1[i] && !solid[i]).collect(),
        surround: (0..solid.len()).map(|i| d4[i] && !solid[i]).collect(),
        far: (0..solid.len()).map(|i| d4[i] && !d2[i]).collect(),
    }
}

fn as_weights(mask: &[bool]) -> Vec<f32> {
    mask.iter().map(|m| f32::from(u8::from(*m))).collect()
}

/// Relative brightness of the band just outside the subject, compared with the band
/// further out, normalised by the same ratio in the reference. ~1: the edit keeps the
/// reference relationship; >1 a brighter rim (halo); <1 a darker rim.
fn rim_index(edit: &Plane, reference: &Plane, near: &[bool], far: &[bool]) -> Option<f64> {
    let (n, f) = (as_weights(near), as_weights(far));
    let e = weighted_mean(edit, &n)? / weighted_mean(edit, &f)?;
    let r = weighted_mean(reference, &n)? / weighted_mean(reference, &f)?;
    (e.is_finite() && r.is_finite() && r > 0.0).then(|| e / r)
}

#[derive(Default, Clone)]
struct Sector {
    edit_near: f64,
    edit_far: f64,
    ref_near: f64,
    ref_far: f64,
    near_count: usize,
    far_count: usize,
    bounds: Option<(usize, usize, usize, usize)>,
}

fn rim_sectors(
    edit: &Plane,
    reference: &Plane,
    mask: &GrayImage,
    b: &Bands,
    count: usize,
) -> Vec<(f64, (usize, usize, usize, usize))> {
    let width = edit.width;
    let (mut cx, mut cy, mut total) = (0.0f64, 0.0f64, 0.0f64);
    for (i, p) in mask.pixels().enumerate() {
        let w = f64::from(p[0]);
        cx += (i % width) as f64 * w;
        cy += (i / width) as f64 * w;
        total += w;
    }
    if total == 0.0 {
        return Vec::new();
    }
    let (cx, cy) = (cx / total, cy / total);
    let mut sectors = vec![Sector::default(); count];
    for i in 0..edit.data.len() {
        if !(b.near[i] || b.far[i]) {
            continue;
        }
        let (x, y) = (i % width, i / width);
        let angle = (y as f64 - cy).atan2(x as f64 - cx) + std::f64::consts::PI;
        let s =
            &mut sectors[((angle / std::f64::consts::TAU * count as f64) as usize).min(count - 1)];
        if b.near[i] {
            s.edit_near += f64::from(edit.data[i]);
            s.ref_near += f64::from(reference.data[i]);
            s.near_count += 1;
            s.bounds = Some(match s.bounds {
                None => (x, y, x, y),
                Some((a, bb, c, d)) => (a.min(x), bb.min(y), c.max(x), d.max(y)),
            });
        } else {
            s.edit_far += f64::from(edit.data[i]);
            s.ref_far += f64::from(reference.data[i]);
            s.far_count += 1;
        }
    }
    sectors
        .into_iter()
        .filter(|s| s.near_count >= 20 && s.far_count >= 20 && s.ref_near > 0.0 && s.edit_far > 0.0)
        .map(|s| {
            let index = (s.edit_near / s.ref_near) / (s.edit_far / s.ref_far);
            (index, s.bounds.unwrap())
        })
        .collect()
}

/// Signed difference (natural log) between each pixel's change and the change of
/// similar-looking reference pixels nearby.
///
/// Without a subject mask, neighbours come from an annulus so a small island does not
/// average only with itself. With a mask (`side[i]` = inside the subject), a pixel is
/// compared with look-alike pixels on the *other* side of the mask, and only where
/// those outnumber its look-alikes on its own side: background seen through the
/// subject, or part of the subject left in the background selection. Only small
/// islands qualify: when look-alikes on the pixel's own side fill a fifth or more of
/// the neighbourhood, the pixel belongs to a large region, such as a white bird on
/// snow deliberately separated by the mask, and is not reported.
fn treatment_difference(
    edit: &Linear,
    reference: &Linear,
    radius: usize,
    side: Option<&[bool]>,
) -> Plane {
    let (width, height) = (reference.luminance.width, reference.luminance.height);
    let ln = |v: f32| (v + EPS).ln();
    let lum: Vec<f32> = reference.luminance.data.iter().map(|v| ln(*v)).collect();
    let cr: Vec<f32> = (0..lum.len())
        .map(|i| ln(reference.r.data[i]) - ln(reference.g.data[i]))
        .collect();
    let cb: Vec<f32> = (0..lum.len())
        .map(|i| ln(reference.b.data[i]) - ln(reference.g.data[i]))
        .collect();
    let gain: Vec<f32> = (0..lum.len())
        .map(|i| ln(edit.luminance.data[i]) - lum[i])
        .collect();
    let inner = if side.is_some() {
        0
    } else {
        (radius / 3).max(2) as isize
    };
    let step = (radius / 12).max(2) as isize;
    let r = radius as isize;
    let data = (0..height)
        .into_par_iter()
        .flat_map_iter(|y| {
            let (lum, cr, cb, gain) = (&lum, &cr, &cb, &gain);
            (0..width).map(move |x| {
                let i = y * width + x;
                // [same side, other side] weighted sums of gain and weight, plus counts.
                let (mut sum, mut total) = ([0.0f32; 2], [0.0f32; 2]);
                let (mut similar, mut samples) = ([0usize; 2], 0usize);
                let mut dy = -r;
                while dy <= r {
                    let yy = y as isize + dy;
                    if yy >= 0 && yy < height as isize {
                        let mut dx = -r;
                        while dx <= r {
                            let xx = x as isize + dx;
                            if xx >= 0
                                && xx < width as isize
                                && dx.abs().max(dy.abs()) >= inner
                                && (dx, dy) != (0, 0)
                            {
                                let j = yy as usize * width + xx as usize;
                                samples += 1;
                                let d = ((lum[i] - lum[j]) / 0.12).powi(2)
                                    + ((cr[i] - cr[j]) / 0.06).powi(2)
                                    + ((cb[i] - cb[j]) / 0.06).powi(2);
                                if d < 9.0 {
                                    let w = (-0.5 * d).exp();
                                    let k = usize::from(side.is_some_and(|s| s[i] != s[j]));
                                    sum[k] += w * gain[j];
                                    total[k] += w;
                                    similar[k] += 1;
                                }
                            }
                            dx += step;
                        }
                    }
                    dy += step;
                }
                match side {
                    None if total[0] >= 4.0 => gain[i] - sum[0] / total[0],
                    Some(_)
                        if total[1] >= 4.0
                            && similar[1] > similar[0]
                            && (similar[0] as f32) < 0.2 * samples as f32 =>
                    {
                        gain[i] - sum[1] / total[1]
                    }
                    _ => 0.0,
                }
            })
        })
        .collect();
    Plane {
        width,
        height,
        data,
    }
}

struct Cluster {
    area: usize,
    mean: f32,
    bounds: (usize, usize, usize, usize),
    inside_subject: f32,
}

fn clusters(difference: &Plane, subject: Option<&[f32]>) -> Vec<Cluster> {
    let (width, height) = (difference.width, difference.height);
    let flagged: Vec<bool> = difference
        .data
        .iter()
        .map(|v| v.abs() > TREATMENT_THRESHOLD)
        .collect();
    let mut seen = vec![false; flagged.len()];
    let mut found = Vec::new();
    for start in 0..flagged.len() {
        if !flagged[start] || seen[start] {
            continue;
        }
        let sign = difference.data[start] > 0.0;
        let mut stack = vec![start];
        seen[start] = true;
        let (mut area, mut sum, mut inside) = (0usize, 0.0f32, 0.0f32);
        let mut bounds = (usize::MAX, usize::MAX, 0, 0);
        while let Some(i) = stack.pop() {
            let (x, y) = (i % width, i / width);
            area += 1;
            sum += difference.data[i];
            inside += subject.map_or(0.0, |s| s[i]);
            bounds = (
                bounds.0.min(x),
                bounds.1.min(y),
                bounds.2.max(x),
                bounds.3.max(y),
            );
            for (nx, ny) in [
                (x.wrapping_sub(1), y),
                (x + 1, y),
                (x, y.wrapping_sub(1)),
                (x, y + 1),
            ] {
                if nx < width && ny < height {
                    let j = ny * width + nx;
                    if flagged[j] && !seen[j] && (difference.data[j] > 0.0) == sign {
                        seen[j] = true;
                        stack.push(j);
                    }
                }
            }
        }
        if area >= 12 {
            found.push(Cluster {
                area,
                mean: sum / area as f32,
                bounds,
                inside_subject: inside / area as f32,
            });
        }
    }
    found.sort_by(|a, b| (b.area as f32 * b.mean.abs()).total_cmp(&(a.area as f32 * a.mean.abs())));
    found.truncate(MAX_REPORTS);
    found
}

fn rendered_box(
    bounds: (usize, usize, usize, usize),
    scale: (f64, f64),
    limit: (u32, u32),
) -> Value {
    let x = (bounds.0 as f64 * scale.0).floor() as u32;
    let y = (bounds.1 as f64 * scale.1).floor() as u32;
    let right = (((bounds.2 + 1) as f64 * scale.0).ceil() as u32).min(limit.0);
    let bottom = (((bounds.3 + 1) as f64 * scale.1).ceil() as u32).min(limit.1);
    json!({"x":x,"y":y,"width":right.saturating_sub(x).max(1),"height":bottom.saturating_sub(y).max(1)})
}

fn stops(ln_ratio: f64) -> f64 {
    (ln_ratio / std::f64::consts::LN_2 * 100.0).round() / 100.0
}

fn round(v: f64) -> f64 {
    (v * 10_000.0).round() / 10_000.0
}

/// Brightness change against the reference, in stops, over the edited photograph's
/// structure: red brightened, blue darkened, grey unchanged, saturating at `range`.
/// A patch whose colour disagrees with the surface it belongs to (a darkened part of a
/// lifted subject, lifted background seen through it) is visible at a glance.
fn gain_map(
    edit: &Plane,
    reference: &Plane,
    range: f32,
    rects: &[(usize, usize, usize, usize)],
) -> DynamicImage {
    let mut image = image::RgbImage::new(edit.width as u32, edit.height as u32);
    for (i, pixel) in image.pixels_mut().enumerate() {
        let base = 60.0 + edit.data[i].clamp(0.0, 1.0).powf(1.0 / 2.2) * 110.0;
        let stops = ((edit.data[i] + EPS) / (reference.data[i] + EPS)).log2();
        let t = (stops / range).clamp(-1.0, 1.0);
        let tint = if t > 0.0 {
            [255.0, 70.0, 50.0]
        } else {
            [50.0, 120.0, 255.0]
        };
        let a = t.abs() * 0.85;
        *pixel = image::Rgb(std::array::from_fn(|c| {
            (base * (1.0 - a) + tint[c] * a).round() as u8
        }));
    }
    for &(x0, y0, x1, y1) in rects {
        for x in x0..=x1.min(edit.width - 1) {
            for y in [y0, y1.min(edit.height - 1)] {
                image.put_pixel(x as u32, y as u32, image::Rgb([255, 220, 0]));
            }
        }
        for y in y0..=y1.min(edit.height - 1) {
            for x in [x0, x1.min(edit.width - 1)] {
                image.put_pixel(x as u32, y as u32, image::Rgb([255, 220, 0]));
            }
        }
    }
    DynamicImage::ImageRgb8(image)
}

/// The session's photograph with the edit's framing and retouching but default
/// tone and colour and no masks, so it renders pixel-aligned with the edit.
pub(crate) fn aligned_reference(session: &Session) -> Session {
    let current = &session.current().adjustments;
    let mut reference_adjustments = validation::default_adjustments();
    for key in GEOMETRY_KEYS.iter().chain(["aiPatches"].iter()) {
        if let Some(value) = current.get(*key) {
            reference_adjustments[*key] = value.clone();
        }
    }
    let mut reference_session = session.clone();
    let mut snapshot = session.current().clone();
    snapshot.adjustments = reference_adjustments;
    snapshot.label = "aligned reference".into();
    reference_session.history = vec![snapshot];
    reference_session.cursor = 0;
    reference_session
}

impl Bridge {
    pub(crate) fn inspect_edit(&self, session: &Session, params: &Value) -> Result<Value> {
        let long_edge = integer(params, "long_edge", 1024, 256, 2048)?;
        let prepared = self.prepare_render(session, false)?;
        let (rw, rh) = prepared.image.dimensions();
        let full = Roi {
            x: 0,
            y: 0,
            width: rw,
            height: rh,
        };

        let reference_session = aligned_reference(session);
        let prepared_reference = self.prepare_render(&reference_session, false)?;
        if prepared_reference.image.dimensions() != (rw, rh) {
            return Err(
                "GEOMETRY_MISMATCH: The reference render does not align with the edit".into(),
            );
        }
        let edit_image = resize_long_edge(
            self.render_prepared(session, &prepared, full, None)?,
            Some(long_edge),
        )?;
        let reference_image = resize_long_edge(
            self.render_prepared(&reference_session, &prepared_reference, full, None)?,
            Some(long_edge),
        )?;
        let (aw, ah) = edit_image.dimensions();
        let scale = (f64::from(rw) / f64::from(aw), f64::from(rh) / f64::from(ah));
        let edit = linear(&edit_image);
        let reference = linear(&reference_image);

        // Frame: brightness, extremes and corners, with the reference for context.
        let frame_mean =
            |p: &Plane| p.data.iter().map(|v| f64::from(*v)).sum::<f64>() / p.data.len() as f64;
        let fraction = |p: &Plane, f: &dyn Fn(f32) -> bool| {
            p.data.iter().filter(|v| f(**v)).count() as f64 / p.data.len() as f64
        };
        let (cw, ch) = ((aw as usize / 10).max(1), (ah as usize / 10).max(1));
        let (w, h) = (aw as usize, ah as usize);
        let corners = |p: &Plane| {
            let mean = frame_mean(p);
            json!({
                "top_left": round(box_mean(p, 0, 0, cw, ch) / mean),
                "top_right": round(box_mean(p, w - cw, 0, w, ch) / mean),
                "bottom_left": round(box_mean(p, 0, h - ch, cw, h) / mean),
                "bottom_right": round(box_mean(p, w - cw, h - ch, w, h) / mean),
            })
        };
        let mut result = json!({
            "session_id": session.id,
            "revision": session.revision,
            "analysis_dimensions": [aw, ah],
            "rendered_dimensions": [rw, rh],
            "reference": "Same crop, geometry and retouching as the edit; default tone and colour; no local masks.",
            "scope": "Measurements of the rendered photograph against the reference. They describe what changed; they are not an aesthetic score or a checklist. Deliberate choices can produce any of these values.",
            "frame": {
                "mean_luminance": {"reference": round(frame_mean(&reference.luminance)), "edit": round(frame_mean(&edit.luminance))},
                "change_stops": stops((frame_mean(&edit.luminance) / frame_mean(&reference.luminance)).ln()),
                "bright_fraction": {"reference": round(fraction(&reference.luminance, &|v| v > 0.8)), "edit": round(fraction(&edit.luminance, &|v| v > 0.8))},
                "deep_shadow_fraction": {"reference": round(fraction(&reference.luminance, &|v| v < 0.002)), "edit": round(fraction(&edit.luminance, &|v| v < 0.002))},
                "corners_to_frame_mean": {"reference": corners(&reference.luminance), "edit": corners(&edit.luminance)},
            },
        });

        let mut look_here = Vec::new();
        let mut rim_entries = Vec::new();
        let mut rects = Vec::new();
        let mut subject_weights = None;
        if let Some(mask_id) = params.get("subject_mask_id") {
            let mask_id = mask_id
                .as_str()
                .filter(|s| !s.is_empty())
                .ok_or("INVALID_ARGUMENT: subject_mask_id must be a nonempty string")?;
            let index = prepared
                .masks
                .iter()
                .position(|m| m.id == mask_id)
                .ok_or_else(|| format!("MASK_NOT_FOUND: No enabled mask with id {mask_id}"))?;
            let mask = imageops::resize(
                &prepared.bitmaps[index],
                aw,
                ah,
                imageops::FilterType::Triangle,
            );
            let edge = integer(params, "edge_width", (long_edge / 200).max(3), 1, 64)? as usize;
            let b = bands(&mask, edge);
            let surround = as_weights(&b.surround);
            let mean = |p: &Plane, weights: &[f32]| weighted_mean(p, weights).unwrap_or(f64::NAN);
            let warmth =
                |l: &Linear, weights: &[f32]| (mean(&l.r, weights) / mean(&l.b, weights)).ln();
            let coverage =
                b.inside.iter().map(|v| f64::from(*v)).sum::<f64>() / b.inside.len() as f64;
            let (si_e, ss_e) = (
                mean(&edit.luminance, &b.inside),
                mean(&edit.luminance, &surround),
            );
            let (si_r, ss_r) = (
                mean(&reference.luminance, &b.inside),
                mean(&reference.luminance, &surround),
            );
            let rim = rim_index(&edit.luminance, &reference.luminance, &b.near, &b.far);
            result["subject"] = json!({
                "mask_id": mask_id,
                "coverage": round(coverage),
                "luminance": {"subject": {"reference": round(si_r), "edit": round(si_e)}, "surround": {"reference": round(ss_r), "edit": round(ss_e)}},
                "subject_to_surround_stops": {"reference": stops((si_r / ss_r).ln()), "edit": stops((si_e / ss_e).ln())},
                "warmth_difference": {
                    "description": "ln(R/B) inside minus surround; positive means the subject is warmer than its surroundings.",
                    "reference": round(warmth(&reference, &b.inside) - warmth(&reference, &surround)),
                    "edit": round(warmth(&edit, &b.inside) - warmth(&edit, &surround)),
                },
                "rim_index": rim.map(round),
                "rim_scope": format!("Band 0–{edge} analysis pixels outside the subject compared with {}–{} pixels out, relative to the reference. 1 keeps the reference relationship; above 1 a brighter rim, below 1 a darker rim.", edge * 2, edge * 4),
                "edge_width_analysis_pixels": edge,
            });
            let mut sectors: Vec<_> =
                rim_sectors(&edit.luminance, &reference.luminance, &mask, &b, 16)
                    .into_iter()
                    .filter(|(index, _)| index.ln().abs() > RIM_THRESHOLD)
                    .collect();
            sectors.sort_by(|a, b| b.0.ln().abs().total_cmp(&a.0.ln().abs()));
            for (index, bounds) in sectors.into_iter().take(MAX_RIM_REPORTS) {
                rects.push(bounds);
                rim_entries.push(json!({
                    "kind": if index > 1.0 { "brighter_rim" } else { "darker_rim" },
                    "rendered_region": rendered_box(bounds, scale, (rw, rh)),
                    "rim_index": round(index),
                    "note": "Edge band differs from the surroundings further out more than in the reference. Can be real light (backlit rim) or a deliberate glow; otherwise inspect the mask edge at native size.",
                }));
            }
            subject_weights = Some(b.inside);
        }

        let radius = integer(params, "similarity_radius", (long_edge / 25).max(8), 3, 96)? as usize;
        let side: Option<Vec<bool>> = subject_weights
            .as_ref()
            .map(|w| w.iter().map(|v| *v >= 0.5).collect());
        let difference = treatment_difference(&edit, &reference, radius, side.as_deref());
        for cluster in clusters(&difference, subject_weights.as_deref()) {
            rects.push(cluster.bounds);
            let mut entry = json!({
                "kind": "similar_pixels_treated_differently",
                "rendered_region": rendered_box(cluster.bounds, scale, (rw, rh)),
                "difference_stops": stops(f64::from(cluster.mean)),
                "area_fraction": round(cluster.area as f64 / (w * h) as f64),
                "note": "This area looked like its neighbours in the reference but was brightened or darkened much more or less than they were. Deliberate for local accents; also the signature of a mask edge crossing one surface, or background seen through the subject.",
            });
            if subject_weights.is_some() {
                entry["inside_subject_fraction"] = json!(round(f64::from(cluster.inside_subject)));
            }
            look_here.push(entry);
        }
        // Specific findings first; edge sectors after them.
        look_here.extend(rim_entries);
        result["look_here"] = json!(look_here);
        result["similarity_radius_analysis_pixels"] = json!(radius);
        if flag(params, "heatmap", true)? {
            let range = number(params, "gain_range_stops", 2.0, 0.25, 6.0)? as f32;
            let map = gain_map(&edit.luminance, &reference.luminance, range, &rects);
            let mut block = image_block(
                &map,
                "Brightness change against the reference: red brightened, blue darkened, grey unchanged; yellow boxes = look_here regions",
            )?;
            block["coordinate_scale"] = json!({"x": scale.0, "y": scale.1});
            block["legend"] = json!({"red": format!("+{range} stops or more"), "blue": format!("-{range} stops or more"), "grey": "unchanged"});
            result["images"] = json!([block]);
        }
        bounded_response(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn uniform(width: usize, height: usize, value: f32) -> Linear {
        let plane = Plane {
            width,
            height,
            data: vec![value; width * height],
        };
        Linear {
            r: plane.clone(),
            g: plane.clone(),
            b: plane.clone(),
            luminance: plane,
        }
    }

    fn disk(width: u32, height: u32, radius: f32) -> GrayImage {
        GrayImage::from_fn(width, height, |x, y| {
            let d = ((x as f32 - width as f32 / 2.0).powi(2)
                + (y as f32 - height as f32 / 2.0).powi(2))
            .sqrt();
            Luma([if d <= radius { 255 } else { 0 }])
        })
    }

    #[test]
    fn a_uniform_change_raises_no_treatment_flags() {
        let reference = uniform(64, 48, 0.2);
        let edit = uniform(64, 48, 0.1);
        let difference = treatment_difference(&edit, &reference, 8, None);
        assert!(difference.data.iter().all(|v| v.abs() < 1e-4));
        assert!(clusters(&difference, None).is_empty());
    }

    #[test]
    fn an_island_treated_unlike_identical_neighbours_is_located() {
        let reference = uniform(80, 60, 0.2);
        let mut edit = uniform(80, 60, 0.1);
        for y in 25..35 {
            for x in 30..42 {
                let i = y * 80 + x;
                edit.luminance.data[i] = 0.3;
            }
        }
        let found = clusters(&treatment_difference(&edit, &reference, 12, None), None);
        assert_eq!(found.len(), 1);
        let (x0, y0, x1, y1) = found[0].bounds;
        assert!(
            x0 >= 28 && x1 <= 43 && y0 >= 23 && y1 <= 36,
            "{:?}",
            found[0].bounds
        );
        assert!(found[0].mean > TREATMENT_THRESHOLD);
    }

    #[test]
    fn different_materials_may_be_treated_differently() {
        // Left half dark, right half bright in the reference; opposite gains are not flagged.
        let mut reference = uniform(60, 40, 0.05);
        let mut edit = uniform(60, 40, 0.1);
        for y in 0..40 {
            for x in 30..60 {
                let i = y * 60 + x;
                reference.luminance.data[i] = 0.5;
                edit.luminance.data[i] = 0.25;
            }
        }
        assert!(clusters(&treatment_difference(&edit, &reference, 8, None), None).is_empty());
    }

    /// Background (0.2) with a large subject (0.6) that has a hole showing background.
    /// The subject mask covers the hole, so the hole gets the subject's lift.
    fn subject_with_gap() -> (Linear, Linear, Vec<bool>) {
        let (w, h) = (90, 70);
        let mut reference = uniform(w, h, 0.2);
        let mut edit = uniform(w, h, 0.1); // background darkened one stop
        let mut side = vec![false; w * h];
        for y in 15..55 {
            for x in 20..60 {
                let i = y * w + x;
                side[i] = true;
                let hole = (35..42).contains(&y) && (30..45).contains(&x);
                let v = if hole { 0.2 } else { 0.6 };
                reference.luminance.data[i] = v;
                reference.r.data[i] = v;
                reference.g.data[i] = v;
                reference.b.data[i] = v;
                edit.luminance.data[i] = v * 1.5; // subject lifted
            }
        }
        (edit, reference, side)
    }

    #[test]
    fn background_seen_through_the_subject_is_located() {
        let (edit, reference, side) = subject_with_gap();
        let found = clusters(
            &treatment_difference(&edit, &reference, 20, Some(&side)),
            None,
        );
        assert_eq!(found.len(), 1, "only the hole");
        let (x0, y0, x1, y1) = found[0].bounds;
        assert!(
            x0 >= 29 && x1 <= 45 && y0 >= 34 && y1 <= 42,
            "{:?}",
            found[0].bounds
        );
        assert!(found[0].mean > TREATMENT_THRESHOLD);
    }

    #[test]
    fn a_subject_matching_a_large_background_is_not_reported() {
        // A white bird on snow: same appearance, deliberately separated by the mask.
        let (w, h) = (90, 70);
        let reference = uniform(w, h, 0.6);
        let mut edit = uniform(w, h, 0.3);
        let mut side = vec![false; w * h];
        for y in 15..55 {
            for x in 20..60 {
                side[y * w + x] = true;
                edit.luminance.data[y * w + x] = 0.9;
            }
        }
        assert!(
            clusters(
                &treatment_difference(&edit, &reference, 20, Some(&side)),
                None
            )
            .is_empty()
        );
    }

    #[test]
    fn rim_index_detects_a_bright_band_outside_the_subject() {
        let mask = disk(100, 100, 25.0);
        let b = bands(&mask, 4);
        let reference = Plane {
            width: 100,
            height: 100,
            data: vec![0.2; 10_000],
        };
        let mut edit = Plane {
            width: 100,
            height: 100,
            data: vec![0.1; 10_000],
        };
        for (i, near) in b.near.iter().enumerate() {
            if *near {
                edit.data[i] = 0.16;
            }
        }
        let index = rim_index(&edit, &reference, &b.near, &b.far).unwrap();
        assert!(index > 1.5, "{index}");
        let clean = Plane {
            width: 100,
            height: 100,
            data: vec![0.1; 10_000],
        };
        assert!((rim_index(&clean, &reference, &b.near, &b.far).unwrap() - 1.0).abs() < 1e-6);
        let sectors = rim_sectors(&edit, &reference, &mask, &b, 8);
        assert_eq!(sectors.len(), 8);
        assert!(sectors.iter().all(|(i, _)| *i > 1.5));
    }

    #[test]
    fn bands_are_ordered_outward_and_disjoint_from_the_subject() {
        let mask = disk(60, 60, 12.0);
        let b = bands(&mask, 3);
        for i in 0..b.near.len() {
            assert!(!(b.near[i] && b.far[i]));
            if b.inside[i] > 0.5 {
                assert!(!b.near[i] && !b.surround[i]);
            }
        }
        assert!(b.near.iter().any(|v| *v) && b.far.iter().any(|v| *v));
    }

    #[test]
    fn gain_map_colours_lifted_red_and_darkened_blue() {
        let reference = Plane {
            width: 2,
            height: 1,
            data: vec![0.2, 0.2],
        };
        let edit = Plane {
            width: 2,
            height: 1,
            data: vec![0.8, 0.05],
        };
        let map = gain_map(&edit, &reference, 2.0, &[]).to_rgb8();
        let (lifted, darkened) = (map.get_pixel(0, 0), map.get_pixel(1, 0));
        assert!(lifted[0] > lifted[2], "{lifted:?}");
        assert!(darkened[2] > darkened[0], "{darkened:?}");
    }

    #[test]
    fn rendered_boxes_scale_and_clamp() {
        let r = rendered_box((10, 5, 19, 9), (4.0, 4.0), (60, 30));
        assert_eq!(r, json!({"x":40,"y":20,"width":20,"height":10}));
    }
}
