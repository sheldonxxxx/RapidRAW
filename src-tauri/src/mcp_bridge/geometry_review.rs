//! Coordinate, resource and editing diagnostics. These operations never commit edits.
use super::{
    Result, flag, number, required,
    sessions::{Bridge, Session},
};
use crate::image_processing::GeometryPointMapper;
use serde_json::{Value, json};
use std::collections::BTreeSet;
use tauri::Manager;

type Point = (f64, f64);

pub(super) struct CoordinateMap {
    source: (u32, u32),
    canvas: (u32, u32),
    pub(super) rendered: (u32, u32),
    crop: Point,
    steps: u64,
    flip_h: bool,
    flip_v: bool,
    rotation: f64,
    geometry: GeometryPointMapper,
}

fn inside(p: Point, d: (u32, u32)) -> bool {
    p.0.is_finite()
        && p.1.is_finite()
        && p.0 >= -0.0001
        && p.1 >= -0.0001
        && p.0 <= d.0.saturating_sub(1) as f64 + 0.0001
        && p.1 <= d.1.saturating_sub(1) as f64 + 0.0001
}

impl CoordinateMap {
    pub(super) fn new(source: (u32, u32), adjustments: &Value) -> Self {
        let steps = adjustments["orientationSteps"].as_u64().unwrap_or(0);
        let canvas = if steps % 2 == 1 {
            (source.1, source.0)
        } else {
            source
        };
        let mut crop = (0.0, 0.0);
        let mut rendered = canvas;
        if let Some(rect) = adjustments.get("crop").filter(|c| c.is_object()) {
            let x = rect["x"].as_f64().unwrap_or(0.0).round() as u32;
            let y = rect["y"].as_f64().unwrap_or(0.0).round() as u32;
            let w = rect["width"].as_f64().unwrap_or(0.0).round() as u32;
            let h = rect["height"].as_f64().unwrap_or(0.0).round() as u32;
            if x < canvas.0 && y < canvas.1 && w > 0 && h > 0 {
                crop = (x as f64, y as f64);
                rendered = ((canvas.0 - x).min(w), (canvas.1 - y).min(h));
            }
        }
        Self {
            source,
            canvas,
            rendered,
            crop,
            steps,
            flip_h: adjustments["flipHorizontal"].as_bool().unwrap_or(false),
            flip_v: adjustments["flipVertical"].as_bool().unwrap_or(false),
            rotation: adjustments["rotation"].as_f64().unwrap_or(0.0),
            geometry: GeometryPointMapper::new(source, adjustments),
        }
    }
    fn rotate(&self, p: Point, inverse: bool) -> Point {
        // Native imageproc rotates about width/2,height/2, with f32 radians.
        let angle = (self.rotation as f32 * std::f32::consts::PI / 180.0) as f64
            * if inverse { -1.0 } else { 1.0 };
        let (s, c) = angle.sin_cos();
        let (cx, cy) = (self.canvas.0 as f64 / 2.0, self.canvas.1 as f64 / 2.0);
        (
            cx + (p.0 - cx) * c - (p.1 - cy) * s,
            cy + (p.0 - cx) * s + (p.1 - cy) * c,
        )
    }
    fn unorient(&self, p: Point) -> Point {
        let (mut x, mut y) = self.rotate(p, true);
        if self.flip_h {
            x = self.canvas.0 as f64 - 1.0 - x;
        }
        if self.flip_v {
            y = self.canvas.1 as f64 - 1.0 - y;
        }
        match self.steps {
            1 => (y, self.source.1 as f64 - 1.0 - x),
            2 => (
                self.source.0 as f64 - 1.0 - x,
                self.source.1 as f64 - 1.0 - y,
            ),
            3 => (self.source.0 as f64 - 1.0 - y, x),
            _ => (x, y),
        }
    }
    fn orient(&self, p: Point) -> Point {
        let (mut x, mut y) = match self.steps {
            1 => (self.source.1 as f64 - 1.0 - p.1, p.0),
            2 => (
                self.source.0 as f64 - 1.0 - p.0,
                self.source.1 as f64 - 1.0 - p.1,
            ),
            3 => (p.1, self.source.0 as f64 - 1.0 - p.0),
            _ => p,
        };
        if self.flip_h {
            x = self.canvas.0 as f64 - 1.0 - x;
        }
        if self.flip_v {
            y = self.canvas.1 as f64 - 1.0 - y;
        }
        self.rotate((x, y), false)
    }
    fn mask_to_source(&self, p: Point) -> Result<Point> {
        let warped = self.unorient(p);
        if !inside(warped, self.source) {
            return Err("outside_image_after_rotation".into());
        }
        let source = self
            .geometry
            .source_point(warped.0, warped.1)
            .ok_or("singular_geometry")?;
        if !inside(source, self.source) {
            return Err("outside_source_after_warp".into());
        }
        Ok(source)
    }
    fn source_to_mask(&self, target: Point) -> Result<Point> {
        // Solve the exact inverse native sampling map. Multiple converged roots
        // are rejected instead of guessing a branch of folded radial geometry.
        let (w, h) = (self.source.0 as f64 - 1.0, self.source.1 as f64 - 1.0);
        let seeds = [
            target,
            (w * 0.2, h * 0.2),
            (w * 0.8, h * 0.2),
            (w * 0.2, h * 0.8),
            (w * 0.8, h * 0.8),
        ];
        let mut roots: Vec<Point> = Vec::new();
        for mut p in seeds {
            for _ in 0..40 {
                let Some(v) = self.geometry.source_point(p.0, p.1) else {
                    break;
                };
                let residual = (v.0 - target.0, v.1 - target.1);
                if residual.0.hypot(residual.1) < 0.003 {
                    if inside(p, self.source)
                        && !roots.iter().any(|r| (r.0 - p.0).hypot(r.1 - p.1) < 0.03)
                    {
                        roots.push(p);
                    }
                    break;
                }
                let delta = 0.25;
                let Some(a) = self.geometry.source_point(p.0 + delta, p.1) else {
                    break;
                };
                let Some(b) = self.geometry.source_point(p.0, p.1 + delta) else {
                    break;
                };
                let (ax, ay, bx, by) = (
                    (a.0 - v.0) / delta,
                    (a.1 - v.1) / delta,
                    (b.0 - v.0) / delta,
                    (b.1 - v.1) / delta,
                );
                let determinant = ax * by - ay * bx;
                if !determinant.is_finite() || determinant.abs() < 1e-8 {
                    break;
                }
                p.0 -= ((by * residual.0 - bx * residual.1) / determinant).clamp(-w, w);
                p.1 -= ((-ay * residual.0 + ax * residual.1) / determinant).clamp(-h, h);
                if p.0.abs() > w * 4.0 + 1.0 || p.1.abs() > h * 4.0 + 1.0 {
                    break;
                }
            }
        }
        match roots.as_slice() {
            [p] => Ok(self.orient(*p)),
            [] => Err("no_visible_inverse_or_nonconvergent_geometry".into()),
            _ => Err("ambiguous_folded_geometry".into()),
        }
    }
}

#[derive(Clone, Copy)]
struct Preview {
    dimensions: (u32, u32),
    region: (f64, f64, f64, f64),
}

fn parse_preview(value: Option<&Value>, map: &CoordinateMap) -> Result<Option<Preview>> {
    let Some(v) = value else {
        return Ok(None);
    };
    let width = integer(v, "width", 1, 32768)?;
    let height = integer(v, "height", 1, 32768)?;
    let region = if let Some(r) = v.get("region") {
        let x = number(r, "x", 0.0, 0.0, map.rendered.0 as f64)?;
        let y = number(r, "y", 0.0, 0.0, map.rendered.1 as f64)?;
        let w = number(
            r,
            "width",
            map.rendered.0 as f64,
            1.0,
            map.rendered.0 as f64,
        )?;
        let h = number(
            r,
            "height",
            map.rendered.1 as f64,
            1.0,
            map.rendered.1 as f64,
        )?;
        if x + w > map.rendered.0 as f64 || y + h > map.rendered.1 as f64 {
            return Err("INVALID_REGION: Preview region is outside rendered image".into());
        }
        (x, y, w, h)
    } else {
        (0.0, 0.0, map.rendered.0 as f64, map.rendered.1 as f64)
    };
    Ok(Some(Preview {
        dimensions: (width, height),
        region,
    }))
}

fn integer(value: &Value, key: &str, min: u32, max: u32) -> Result<u32> {
    let n = number(value, key, 0.0, min as f64, max as f64)?;
    if n.fract() != 0.0 {
        return Err(format!("INVALID_ARGUMENT: {key} must be an integer"));
    }
    Ok(n as u32)
}

fn point(value: &Value) -> Result<Point> {
    let x = value["x"]
        .as_f64()
        .filter(|v| v.is_finite())
        .ok_or("INVALID_ARGUMENT: Point x must be finite")?;
    let y = value["y"]
        .as_f64()
        .filter(|v| v.is_finite())
        .ok_or("INVALID_ARGUMENT: Point y must be finite")?;
    Ok((x, y))
}

fn map_point(
    map: &CoordinateMap,
    p: Point,
    from: &str,
    to: &str,
    preview: Option<Preview>,
) -> Result<Point> {
    let dimensions = |space: &str| -> Result<(u32, u32)> {
        Ok(match space {
            "oriented_source" => map.source,
            "mask" => map.canvas,
            "rendered" => map.rendered,
            "preview" => {
                preview
                    .ok_or("INVALID_ARGUMENT: preview dimensions are required")?
                    .dimensions
            }
            _ => return Err("INVALID_ARGUMENT: Unknown coordinate space".into()),
        })
    };
    if !inside(p, dimensions(from)?) {
        return Err("outside_input_canvas".into());
    }
    if from == to {
        return Ok(p);
    }
    let mut source = p;
    if from != "oriented_source" {
        if from == "preview" {
            let v = preview.unwrap();
            source = (
                v.region.0 + (p.0 + 0.5) * v.region.2 / v.dimensions.0 as f64 - 0.5,
                v.region.1 + (p.1 + 0.5) * v.region.3 / v.dimensions.1 as f64 - 0.5,
            );
        }
        if from != "mask" {
            source = (source.0 + map.crop.0, source.1 + map.crop.1);
        }
        if to != "oriented_source" {
            // Canvas-to-canvas mapping does not invert distortions or encounter
            // ambiguous source correspondences. Keep exact coordinate identity.
            let mut output = source;
            if to != "mask" {
                output = (output.0 - map.crop.0, output.1 - map.crop.1);
            }
            if to == "preview" {
                let v = preview.unwrap();
                output = (
                    (output.0 - v.region.0 + 0.5) * v.dimensions.0 as f64 / v.region.2 - 0.5,
                    (output.1 - v.region.1 + 0.5) * v.dimensions.1 as f64 / v.region.3 - 0.5,
                );
            }
            return if inside(output, dimensions(to)?) {
                Ok(output)
            } else {
                Err("outside_output_canvas_or_crop".into())
            };
        }
        source = map.mask_to_source(source)?;
    }
    let mut output = source;
    if to != "oriented_source" {
        output = map.source_to_mask(source)?;
        if to != "mask" {
            output = (output.0 - map.crop.0, output.1 - map.crop.1);
        }
        if to == "preview" {
            let v = preview.unwrap();
            output = (
                (output.0 - v.region.0 + 0.5) * v.dimensions.0 as f64 / v.region.2 - 0.5,
                (output.1 - v.region.1 + 0.5) * v.dimensions.1 as f64 / v.region.3 - 0.5,
            );
        }
    }
    if inside(output, dimensions(to)?) {
        Ok(output)
    } else {
        Err("outside_output_canvas_or_crop".into())
    }
}

impl Bridge {
    pub(super) fn map_coordinates(&self, session: &Session, params: &Value) -> Result<Value> {
        let map = CoordinateMap::new(session.dimensions, &session.current().adjustments);
        let from = required(params, "from")?;
        let to = required(params, "to")?;
        for space in [from, to] {
            if !["oriented_source", "mask", "rendered", "preview"].contains(&space) {
                return Err("INVALID_ARGUMENT: Unknown coordinate space".into());
            }
        }
        let preview = parse_preview(params.get("preview"), &map)?;
        if [from, to].contains(&"preview") && preview.is_none() {
            return Err("INVALID_ARGUMENT: preview dimensions are required".into());
        }
        let convert = |p: Point| -> Value {
            match map_point(&map, p, from, to, preview) {
                Ok(q) => json!({"input":{"x":p.0,"y":p.1},"mapped":true,"x":q.0,"y":q.1}),
                Err(reason) => json!({"input":{"x":p.0,"y":p.1},"mapped":false,"reason":reason}),
            }
        };
        let mut result = json!({"session_id":session.id,"revision":session.revision,"from":from,"to":to,
            "coordinates":"Pixel centers: top-left pixel is (0,0). oriented_source includes EXIF decoding orientation, before user edits. mask is the corrected, user-oriented/flipped/rotated canvas before crop. preview uses pixel-center resize scaling.",
            "source_dimensions":map.source,"mask_dimensions":map.canvas,"rendered_dimensions":map.rendered,
            "source_sampling_channel":"green; lens TCA may sample red and blue at different positions",
            "inverse_tolerance_pixels":0.003,"state_unchanged":true});
        let mut count = 0;
        if let Some(values) = params.get("points") {
            let values = values
                .as_array()
                .ok_or("INVALID_ARGUMENT: points must be an array")?;
            count += values.len();
            if count > 4096 {
                return Err("INVALID_ARGUMENT: At most 4096 coordinate samples".into());
            }
            result["points"] = Value::Array(
                values
                    .iter()
                    .map(|v| point(v).map(&convert))
                    .collect::<Result<Vec<_>>>()?,
            );
        }
        if let Some(strokes) = params.get("strokes") {
            let strokes = strokes
                .as_array()
                .ok_or("INVALID_ARGUMENT: strokes must be an array")?;
            let mut converted = Vec::new();
            for stroke in strokes {
                let values = stroke
                    .as_array()
                    .ok_or("INVALID_ARGUMENT: Every stroke must be an array of points")?;
                count += values.len();
                if count > 4096 {
                    return Err("INVALID_ARGUMENT: At most 4096 coordinate samples".into());
                }
                converted.push(Value::Array(
                    values
                        .iter()
                        .map(|v| point(v).map(&convert))
                        .collect::<Result<Vec<_>>>()?,
                ));
            }
            result["strokes"] = json!(converted);
        }
        if let Some(regions) = params.get("regions") {
            let regions = regions
                .as_array()
                .ok_or("INVALID_ARGUMENT: regions must be an array")?;
            count += regions.len() * 128;
            if count > 4096 {
                return Err("INVALID_ARGUMENT: At most 4096 coordinate samples; each region uses 128 boundary samples".into());
            }
            let mut converted = Vec::new();
            for r in regions {
                let (x, y) = point(r)?;
                let width = number(r, "width", 0.0, 1.0, 100000.0)?;
                let height = number(r, "height", 0.0, 1.0, 100000.0)?;
                let mut boundary = Vec::new();
                for edge in 0..4 {
                    for sample in 0..32 {
                        let t = sample as f64 / 31.0;
                        let p = match edge {
                            0 => (x + t * (width - 1.0), y),
                            1 => (x + width - 1.0, y + t * (height - 1.0)),
                            2 => (x + (1.0 - t) * (width - 1.0), y + height - 1.0),
                            _ => (x, y + (1.0 - t) * (height - 1.0)),
                        };
                        boundary.push(convert(p));
                    }
                }
                let mapped: Vec<Point> = boundary
                    .iter()
                    .filter(|v| v["mapped"] == true)
                    .map(|v| (v["x"].as_f64().unwrap(), v["y"].as_f64().unwrap()))
                    .collect();
                let bounds = if mapped.is_empty() {
                    Value::Null
                } else {
                    let min_x = mapped.iter().map(|p| p.0).fold(f64::INFINITY, f64::min);
                    let min_y = mapped.iter().map(|p| p.1).fold(f64::INFINITY, f64::min);
                    let max_x = mapped.iter().map(|p| p.0).fold(f64::NEG_INFINITY, f64::max);
                    let max_y = mapped.iter().map(|p| p.1).fold(f64::NEG_INFINITY, f64::max);
                    json!({"x":min_x,"y":min_y,"width":max_x-min_x+1.0,"height":max_y-min_y+1.0})
                };
                converted.push(json!({"input":r,"boundary":boundary,"mapped_samples":mapped.len(),"complete":mapped.len()==128,"sampled_bounds":bounds,"bounds_are_approximate":true}));
            }
            result["regions"] = json!(converted);
        }
        if count == 0 {
            return Err("INVALID_ARGUMENT: Supply nonempty points, strokes or regions".into());
        }
        Ok(result)
    }

    pub(super) fn preflight(&self, session: &Session, params: &Value) -> Result<Value> {
        let operation = params["operation"].as_str().unwrap_or("render");
        if ![
            "render",
            "export",
            "denoise",
            "mask_generate",
            "retouch",
            "merge",
        ]
        .contains(&operation)
        {
            return Err("INVALID_ARGUMENT: Unsupported preflight operation".into());
        }
        let map = CoordinateMap::new(session.dimensions, &session.current().adjustments);
        let state = self.handle.state::<crate::app_state::AppState>();
        let context = crate::image_processing::get_or_init_gpu_context(&state, &self.handle)?;
        let limit = context.limits.max_texture_dimension_2d;
        let mut blockers = Vec::new();
        let mut warnings = Vec::new();
        let requires_streaming = map.rendered.0 > limit || map.rendered.1 > limit;
        let streaming_supported =
            ["render", "export"].contains(&operation) && params["format"] != "cube";
        let mut streaming_plan = Value::Null;
        if streaming_supported {
            let tone_mapper = crate::image_processing::resolve_tonemapper_override_from_handle(
                &self.handle,
                session.is_raw,
            );
            let adjustments = crate::image_processing::get_all_adjustments_from_json(
                &session.current().adjustments,
                session.is_raw,
                tone_mapper,
            );
            match crate::gpu_processing::high_precision_render_preflight(
                map.rendered,
                &adjustments,
                &context,
            ) {
                Ok(Some((halo, core))) => {
                    streaming_plan = json!({"halo_pixels":halo,"core_pixels":core});
                    warnings.push("This image requires streamed native GPU rendering; peak CPU memory still includes full-resolution geometry and mask buffers".to_string());
                }
                Ok(None) => {}
                Err(message) => {
                    blockers.push(json!({"code":"RENDER_RESOURCE_LIMIT","message":message}))
                }
            }
        } else if requires_streaming {
            warnings.push(format!("Image dimensions exceed GPU texture dimension {limit}. Native rendering supports streaming, but the selected operation's resource requirements are independent and are not fully predicted here"));
        }
        let masks = session.current().adjustments["masks"]
            .as_array()
            .map_or(0, |masks| {
                masks.iter().filter(|mask| mask["visible"] == true).count()
            });
        let mut output = Value::Null;
        if operation == "export" || params.get("format").is_some() {
            let format = params["format"].as_str().unwrap_or("jpeg");
            let supported = [
                "jpeg", "jpg", "png", "tiff", "tif", "webp", "avif", "jxl", "cube",
            ]
            .contains(&format);
            if !supported {
                blockers.push(json!({"code":"UNSUPPORTED_FORMAT","message":format!("Unknown format {format}")}));
            }
            let default_depth = if ["png", "tiff", "tif"].contains(&format) {
                16
            } else {
                8
            };
            let depth = params["bit_depth"].as_u64().unwrap_or(default_depth);
            if ![8, 16].contains(&depth) || depth == 16 && !["png", "tiff", "tif"].contains(&format)
            {
                blockers.push(json!({"code":"UNSUPPORTED_BIT_DEPTH","message":"16-bit raster export requires PNG or TIFF; other raster formats support 8-bit"}));
            }
            if format == "cube" && params.get("bit_depth").is_some() {
                blockers.push(json!({"code":"INAPPLICABLE_EXPORT_OPTION","message":"bit_depth does not apply to CUBE LUT exports"}));
            }
            let metadata = ["jpeg", "jpg", "png", "webp"].contains(&format);
            if flag(params, "keep_metadata", true)? && !metadata && format != "cube" {
                warnings.push(
                    "This format does not currently preserve source EXIF metadata".to_string(),
                );
            }
            output = json!({"format":format,"bit_depth":depth,"metadata_supported":metadata,"dimensions_before_resize":map.rendered});
        }
        let model_kind = params
            .get("model_kind")
            .and_then(Value::as_str)
            .or(match operation {
                "mask_generate" => Some("masks"),
                _ => None,
            });
        let models = if let Some(kind) = model_kind {
            if !["masks", "inpaint", "denoise"].contains(&kind) {
                return Err(
                    "INVALID_ARGUMENT: model_kind must be masks, inpaint or denoise".into(),
                );
            }
            let status = self.models_status()?;
            let group = status["groups"][kind].clone();
            if group["ready"] != true {
                blockers.push(json!({"code":"MODEL_NOT_READY","message":format!("Use install_model kind={kind} to verify/copy/download the required assets")}));
            }
            json!({"kind":kind,"status":group})
        } else {
            Value::Null
        };
        let source_pixels = session.dimensions.0 as u64 * session.dimensions.1 as u64;
        let rendered_pixels = map.rendered.0 as u64 * map.rendered.1 as u64;
        Ok(
            json!({"session_id":session.id,"revision":session.revision,"operation":operation,"ready":blockers.is_empty(),"source_dimensions":session.dimensions,"rendered_dimensions":map.rendered,
            "gpu":{"max_texture_dimension_2d":limit,"max_buffer_size":context.limits.max_buffer_size,"requires_streaming":requires_streaming,"streaming_supported_for_operation":streaming_supported,"streaming_plan":streaming_plan},
            "memory_lower_bound_bytes":{"decoded_source_rgb32":source_pixels*12,"rendered_rgba16":rendered_pixels*8,"mask_bitmaps":rendered_pixels*masks as u64},
            "memory_scope":"Lower bounds for individual buffers; excludes GPU scratch, decoder, AI and merge allocations. This is not a peak-memory guarantee.",
            "output":output,"models":models,"blockers":blockers,"warnings":warnings,"state_unchanged":true}),
        )
    }
}

fn merge(target: &mut Value, patch: &Value) {
    if let (Some(target), Some(patch)) = (target.as_object_mut(), patch.as_object()) {
        for (key, value) in patch {
            if value.is_object() && target.get(key).is_some_and(Value::is_object) {
                merge(target.get_mut(key).unwrap(), value);
            } else {
                target.insert(key.clone(), value.clone());
            }
        }
    }
}

/// Apply atomic submask edits to the caller's cloned mask. The normal commit
/// validates the resulting native schema and enforces the session revision.
pub(super) fn apply_submask_operations(
    mask: &mut Value,
    operations: &Value,
) -> Result<Vec<String>> {
    let operations = operations
        .as_array()
        .filter(|ops| !ops.is_empty() && ops.len() <= 128)
        .ok_or("INVALID_ARGUMENT: submask_operations must contain 1..128 operations")?;
    let mut candidate = mask.clone();
    let submasks = candidate["subMasks"]
        .as_array_mut()
        .ok_or("INVALID_MASK: subMasks must be an array")?;
    let mut affected = Vec::new();
    for op in operations {
        let action = required(op, "operation")?;
        let allowed: &[&str] =
            match action {
                "add" => &["operation", "submask", "index"],
                "edit" => &["operation", "submask_id", "patch"],
                "remove" => &["operation", "submask_id"],
                "duplicate" => &["operation", "submask_id", "index"],
                "reorder" => &["operation", "order"],
                _ => return Err(
                    "INVALID_ARGUMENT: operation must be add, edit, remove, reorder or duplicate"
                        .into(),
                ),
            };
        if let Some(object) = op.as_object()
            && let Some(key) = object.keys().find(|key| !allowed.contains(&key.as_str()))
        {
            return Err(format!(
                "INVALID_ARGUMENT: Unknown {action} submask operation field {key}"
            ));
        }
        if action == "reorder" {
            let order = op["order"]
                .as_array()
                .ok_or("INVALID_ARGUMENT: reorder requires order array")?;
            let ids = order
                .iter()
                .map(|v| {
                    v.as_str()
                        .ok_or("INVALID_ARGUMENT: order entries must be submask IDs".to_string())
                })
                .collect::<Result<Vec<_>>>()?;
            let unique: BTreeSet<_> = ids.iter().copied().collect();
            if unique.len() != submasks.len()
                || ids.len() != submasks.len()
                || !submasks
                    .iter()
                    .all(|s| s["id"].as_str().is_some_and(|id| unique.contains(id)))
            {
                return Err(
                    "INVALID_ARGUMENT: order must contain every submask ID exactly once".into(),
                );
            }
            *submasks = ids
                .iter()
                .map(|id| submasks.iter().find(|s| s["id"] == *id).unwrap().clone())
                .collect();
            continue;
        }
        if action == "add" {
            let mut submask = op["submask"]
                .as_object()
                .cloned()
                .map(Value::Object)
                .ok_or("INVALID_ARGUMENT: add requires submask object")?;
            if submask.get("id").is_some() {
                return Err("INVALID_ARGUMENT: New submask IDs are generated by the engine".into());
            }
            let id = uuid::Uuid::new_v4().to_string();
            submask["id"] = json!(id);
            for (key, value) in [
                ("visible", json!(true)),
                ("invert", json!(false)),
                ("opacity", json!(100)),
                ("mode", json!("additive")),
                ("parameters", json!({})),
            ] {
                if submask.get(key).is_none() {
                    submask[key] = value;
                }
            }
            let index = op
                .get("index")
                .map(|_| integer(op, "index", 0, submasks.len() as u32))
                .transpose()?
                .unwrap_or(submasks.len() as u32) as usize;
            submasks.insert(index, submask);
            affected.push(id);
            continue;
        }
        let id = required(op, "submask_id")?;
        let index = submasks
            .iter()
            .position(|s| s["id"] == id)
            .ok_or("SUBMASK_NOT_FOUND: Unknown submask ID")?;
        match action {
            "remove" => {
                submasks.remove(index);
                affected.push(id.to_string());
            }
            "edit" => {
                let patch = op["patch"]
                    .as_object()
                    .ok_or("INVALID_ARGUMENT: edit requires patch object")?;
                if patch.contains_key("id") {
                    return Err("INVALID_ARGUMENT: A submask ID cannot be changed".into());
                }
                merge(&mut submasks[index], &Value::Object(patch.clone()));
                affected.push(id.to_string());
            }
            "duplicate" => {
                let mut duplicate = submasks[index].clone();
                let new_id = uuid::Uuid::new_v4().to_string();
                duplicate["id"] = json!(new_id);
                let position = op
                    .get("index")
                    .map(|_| integer(op, "index", 0, submasks.len() as u32))
                    .transpose()?
                    .unwrap_or((index + 1) as u32) as usize;
                submasks.insert(position, duplicate);
                affected.push(new_id);
            }
            _ => {
                return Err(
                    "INVALID_ARGUMENT: operation must be add, edit, remove, reorder or duplicate"
                        .into(),
                );
            }
        }
    }
    *mask = candidate;
    Ok(affected)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::image_processing::{
        apply_coarse_rotation, apply_crop, apply_flip, apply_geometry_warp, apply_rotation,
    };
    use image::{DynamicImage, ImageBuffer, Rgb};

    #[test]
    fn orientation_flips_crop_and_preview_are_pixel_center_exact() {
        for step in 0..4 {
            for h in [false, true] {
                for v in [false, true] {
                    let a = json!({"orientationSteps":step,"flipHorizontal":h,"flipVertical":v,"crop":{"x":2,"y":3,"width":20,"height":18}});
                    let map = CoordinateMap::new((40, 30), &a);
                    let source = DynamicImage::ImageRgb32F(ImageBuffer::from_fn(40, 30, |x, y| {
                        Rgb([x as f32, y as f32, 1.0])
                    }));
                    let oriented = apply_coarse_rotation(source, step as u8);
                    let flipped = apply_flip(oriented, h, v);
                    let output = apply_crop(flipped, &a["crop"]).into_owned().to_rgb32f();
                    for (x, y) in [(0, 0), (8, 7), (19, 17)] {
                        let p = map_point(
                            &map,
                            (x as f64, y as f64),
                            "rendered",
                            "oriented_source",
                            None,
                        )
                        .unwrap();
                        let actual = output.get_pixel(x, y);
                        assert!(
                            (p.0 - actual[0] as f64).abs() < 1e-6
                                && (p.1 - actual[1] as f64).abs() < 1e-6
                        );
                        let back = map_point(&map, p, "oriented_source", "rendered", None).unwrap();
                        assert!((back.0 - x as f64).hypot(back.1 - y as f64) < 0.003);
                    }
                }
            }
        }
        let map = CoordinateMap::new(
            (100, 80),
            &json!({"crop":{"x":10,"y":20,"width":60,"height":40}}),
        );
        let preview = Some(Preview {
            dimensions: (30, 20),
            region: (0., 0., 60., 40.),
        });
        assert_eq!(
            map_point(&map, (0., 0.), "preview", "rendered", preview).unwrap(),
            (0.5, 0.5)
        );
        assert_eq!(
            map_point(&map, (0.5, 0.5), "rendered", "preview", preview).unwrap(),
            (0., 0.)
        );
        assert!(map_point(&map, (0., 0.), "oriented_source", "rendered", preview).is_err());
    }

    #[test]
    fn warped_coordinate_ramp_matches_native_pixels() {
        let cases = [
            json!({"transformVertical":12,"transformHorizontal":-8,"transformRotate":3,"transformScale":110}),
            json!({"transformDistortion":12,"rotation":3,"flipHorizontal":true,"orientationSteps":1}),
            json!({"lensDistortionParams":{"k1":0.025,"k2":-0.004,"k3":0.001,"model":0},"lensDistortionAmount":80}),
            json!({"lensDistortionParams":{"k1":0.005,"k2":0.015,"k3":-0.002,"model":1},"transformDistortion":4}),
            json!({"guidedPerspective":{"enabled":true,"lines":[{"id":"left","type":"vertical","p1":{"x":0.2,"y":0.15},"p2":{"x":0.1,"y":0.9}},{"id":"right","type":"vertical","p1":{"x":0.8,"y":0.15},"p2":{"x":0.9,"y":0.9}}]}}),
        ];
        for a in cases {
            let map = CoordinateMap::new((120, 90), &a);
            let source = DynamicImage::ImageRgb32F(ImageBuffer::from_fn(120, 90, |x, y| {
                Rgb([x as f32, y as f32, 1.0])
            }));
            let warped = apply_geometry_warp(source, &a);
            let oriented =
                apply_coarse_rotation(warped, a["orientationSteps"].as_u64().unwrap_or(0) as u8);
            let flipped = apply_flip(
                oriented,
                a["flipHorizontal"].as_bool().unwrap_or(false),
                false,
            );
            let rendered = apply_rotation(flipped, a["rotation"].as_f64().unwrap_or(0.0) as f32)
                .into_owned()
                .to_rgb32f();
            for (x, y) in [(30, 30), (50, 45), (60, 60)] {
                let p = map_point(
                    &map,
                    (x as f64, y as f64),
                    "rendered",
                    "oriented_source",
                    None,
                )
                .unwrap();
                let actual = rendered.get_pixel(x, y);
                assert!(
                    (p.0 - actual[0] as f64).hypot(p.1 - actual[1] as f64) < 0.03,
                    "{a}: mapped {p:?}, pixel {actual:?}"
                );
                let back = map_point(&map, p, "oriented_source", "rendered", None).unwrap();
                assert!(
                    (back.0 - x as f64).hypot(back.1 - y as f64) < 0.01,
                    "{a}: {back:?}"
                );
            }
        }
    }

    #[test]
    fn submask_operations_preserve_ids_and_are_atomic() {
        let mut mask = json!({"id":"parent","subMasks":[{"id":"a","type":"radial","parameters":{"center":{"x":5,"y":6}},"opacity":100}]});
        apply_submask_operations(&mut mask,&json!([{ "operation":"edit","submask_id":"a","patch":{"parameters":{"center":{"x":7}}}}])).unwrap();
        assert_eq!(
            mask["subMasks"][0]["parameters"]["center"],
            json!({"x":7,"y":6})
        );
        let ids = apply_submask_operations(
            &mut mask,
            &json!([{ "operation":"duplicate","submask_id":"a"}]),
        )
        .unwrap();
        assert_ne!(ids[0], "a");
        apply_submask_operations(
            &mut mask,
            &json!([{ "operation":"reorder","order":[ids[0],"a"]}]),
        )
        .unwrap();
        assert_eq!(mask["subMasks"][1]["id"], "a");
        let before = mask.clone();
        assert!(apply_submask_operations(&mut mask,&json!([{ "operation":"remove","submask_id":"a"},{"operation":"edit","submask_id":"missing","patch":{}}])).is_err());
        assert_eq!(mask, before);
        assert!(
            apply_submask_operations(
                &mut mask,
                &json!([{ "operation":"reorder","order":["a","a"]}])
            )
            .is_err()
        );
    }
}
