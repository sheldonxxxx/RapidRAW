//! Mask requests expressed in the coordinates of an image the agent has looked at.
//! `coordinate_space: {"space": "rendered"}` or `{"space": "preview", "preview": {...}}`
//! converts every position and size in a mask request into the pre-crop mask canvas
//! before the request runs, so points read off a preview never need hand scaling.
use super::{
    Result,
    geometry_review::{CoordinateMap, parse_preview},
    sessions::Session,
};
use serde_json::{Value, json};

pub(super) const KEY: &str = "coordinate_space";

/// Affine map from the input space to the mask canvas: pixel centres map as
/// `offset + (p + 0.5) * scale - 0.5`, edges and lengths as `offset + p * scale`.
#[derive(Clone, Copy, Debug)]
struct Transform {
    scale: (f64, f64),
    offset: (f64, f64),
    input: (f64, f64),
}

impl Transform {
    fn point(&self, x: f64, y: f64) -> (f64, f64) {
        (
            self.offset.0 + (x + 0.5) * self.scale.0 - 0.5,
            self.offset.1 + (y + 0.5) * self.scale.1 - 0.5,
        )
    }
    fn length(&self, value: f64) -> f64 {
        value * (self.scale.0 + self.scale.1) / 2.0
    }
    fn inside(&self, x: f64, y: f64) -> bool {
        x.is_finite()
            && y.is_finite()
            && x >= -0.5
            && y >= -0.5
            && x <= self.input.0 - 0.5
            && y <= self.input.1 - 0.5
    }
}

fn transform(session: &Session, spec: &Value) -> Result<(Transform, String)> {
    let space = spec["space"]
        .as_str()
        .ok_or("INVALID_ARGUMENT: coordinate_space.space must be rendered, preview or mask")?;
    if let Some(key) = spec.as_object().and_then(|o| {
        o.keys()
            .find(|k| !["space", "preview"].contains(&k.as_str()))
    }) {
        return Err(format!(
            "INVALID_ARGUMENT: Unknown coordinate_space field {key}"
        ));
    }
    let map = CoordinateMap::new(session.dimensions, &session.current().adjustments);
    let rendered = (map.rendered.0 as f64, map.rendered.1 as f64);
    let t = match space {
        "mask" => Transform {
            scale: (1.0, 1.0),
            offset: (0.0, 0.0),
            input: (f64::INFINITY, f64::INFINITY),
        },
        "rendered" => Transform {
            scale: (1.0, 1.0),
            offset: map.crop,
            input: rendered,
        },
        "preview" => {
            let preview = parse_preview(spec.get("preview"), &map)?
                .ok_or("INVALID_ARGUMENT: coordinate_space preview requires preview dimensions")?;
            let (w, h) = (preview.dimensions.0 as f64, preview.dimensions.1 as f64);
            Transform {
                scale: (preview.region.2 / w, preview.region.3 / h),
                offset: (map.crop.0 + preview.region.0, map.crop.1 + preview.region.1),
                input: (w, h),
            }
        }
        _ => {
            return Err(
                "INVALID_ARGUMENT: coordinate_space.space must be rendered, preview or mask".into(),
            );
        }
    };
    if space != "preview" && spec.get("preview").is_some() {
        return Err("INVALID_ARGUMENT: preview applies only to coordinate_space preview".into());
    }
    Ok((t, space.to_string()))
}

fn finite(value: &Value, path: &str) -> Result<f64> {
    value
        .as_f64()
        .filter(|v| v.is_finite())
        .ok_or(format!("INVALID_ARGUMENT: {path} must be a finite number"))
}

/// Converts an x/y key pair in place. Both keys must be present together.
fn pair(
    object: &mut Value,
    keys: (&str, &str),
    t: &Transform,
    bounded: bool,
    path: &str,
) -> Result<()> {
    match (object.get(keys.0), object.get(keys.1)) {
        (None, None) => Ok(()),
        (Some(x), Some(y)) => {
            let (x, y) = (
                finite(x, &format!("{path}.{}", keys.0))?,
                finite(y, &format!("{path}.{}", keys.1))?,
            );
            if bounded && !t.inside(x, y) {
                return Err(format!(
                    "INVALID_ARGUMENT: {path}.{}/{} ({x}, {y}) is outside the {}x{} coordinate space",
                    keys.0, keys.1, t.input.0, t.input.1
                ));
            }
            let (mx, my) = t.point(x, y);
            object[keys.0] = json!(mx);
            object[keys.1] = json!(my);
            Ok(())
        }
        _ => Err(format!(
            "INVALID_ARGUMENT: {path} must give {} and {} together when coordinate_space is set",
            keys.0, keys.1
        )),
    }
}

fn scale_key(object: &mut Value, key: &str, factor: f64, path: &str) -> Result<()> {
    if let Some(v) = object.get(key) {
        let v = finite(v, &format!("{path}.{key}"))?;
        object[key] = json!(v * factor);
    }
    Ok(())
}

/// Converts the native parameters of one submask type. Types without positions
/// (AI depth, sky, foreground, all) are unchanged.
fn parameters(kind: &str, p: &mut Value, t: &Transform, path: &str) -> Result<()> {
    if !p.is_object() {
        return Ok(());
    }
    let iso = t.length(1.0);
    match kind {
        "radial" => {
            pair(p, ("centerX", "centerY"), t, false, path)?;
            scale_key(p, "radiusX", t.scale.0, path)?;
            scale_key(p, "radiusY", t.scale.1, path)?;
        }
        "linear" => {
            pair(p, ("startX", "startY"), t, false, path)?;
            pair(p, ("endX", "endY"), t, false, path)?;
            for key in ["range", "fadeBefore", "fadeAfter"] {
                scale_key(p, key, iso, path)?;
            }
        }
        "brush" | "flow" | "clone" | "heal" | "liquify" | "retouch" => {
            pair(p, ("sourceX", "sourceY"), t, true, path)?;
            if let Some(lines) = p.get_mut("lines").and_then(Value::as_array_mut) {
                for (i, line) in lines.iter_mut().enumerate() {
                    let line_path = format!("{path}.lines[{i}]");
                    scale_key(line, "brushSize", iso, &line_path)?;
                    if let Some(points) = line.get_mut("points").and_then(Value::as_array_mut) {
                        for (j, point) in points.iter_mut().enumerate() {
                            pair(
                                point,
                                ("x", "y"),
                                t,
                                false,
                                &format!("{line_path}.points[{j}]"),
                            )?;
                        }
                    }
                }
            }
        }
        "color" | "luminance" => pair(p, ("targetX", "targetY"), t, true, path)?,
        "ai-subject" | "quick-eraser" => {
            // A rectangle: convert its edges, not pixel centres.
            for (x, y) in [("startX", "startY"), ("endX", "endY")] {
                match (p.get(x), p.get(y)) {
                    (None, None) => {}
                    (Some(vx), Some(vy)) => {
                        let (vx, vy) = (finite(vx, path)?, finite(vy, path)?);
                        p[x] = json!(t.offset.0 + vx * t.scale.0);
                        p[y] = json!(t.offset.1 + vy * t.scale.1);
                    }
                    _ => {
                        return Err(format!(
                            "INVALID_ARGUMENT: {path} must give {x} and {y} together"
                        ));
                    }
                }
            }
        }
        _ => {}
    }
    Ok(())
}

fn submask_kind<'a>(session: &'a Session, mask_id: &str, submask_id: &str) -> Option<&'a str> {
    session.current().adjustments["masks"]
        .as_array()?
        .iter()
        .find(|m| m["id"] == mask_id)?["subMasks"]
        .as_array()?
        .iter()
        .find(|s| s["id"] == submask_id)?["type"]
        .as_str()
}

/// Returns the request rewritten in mask-canvas coordinates plus a description of
/// the conversion, or `None` when the request carries no `coordinate_space`.
pub(super) fn to_mask_space(
    method: &str,
    session: &Session,
    params: &Value,
) -> Result<Option<(Value, Value)>> {
    let Some(spec) = params.get(KEY) else {
        return Ok(None);
    };
    if !["mask_create", "mask_update", "mask_generate"].contains(&method) {
        return Err(format!(
            "INVALID_ARGUMENT: {KEY} applies only to mask_create, mask_update and mask_generate"
        ));
    }
    let (t, space) = transform(session, spec)?;
    let mut out = params.clone();
    out.as_object_mut().unwrap().remove(KEY);
    match method {
        "mask_create" => {
            let kind = out["type"].as_str().unwrap_or_default().to_string();
            if let Some(p) = out.get_mut("parameters") {
                parameters(&kind, p, &t, "parameters")?;
            }
        }
        "mask_update" => {
            if out["patch"].get("subMasks").is_some() {
                return Err(format!(
                    "INVALID_ARGUMENT: With {KEY}, change components through submask_operations rather than patch.subMasks"
                ));
            }
            let mask_id = out["mask_id"].as_str().unwrap_or_default().to_string();
            if let Some(ops) = out
                .get_mut("submask_operations")
                .and_then(Value::as_array_mut)
            {
                for (i, op) in ops.iter_mut().enumerate() {
                    let path = format!("submask_operations[{i}]");
                    match op["operation"].as_str() {
                        Some("add") => {
                            let kind = op["submask"]["type"]
                                .as_str()
                                .unwrap_or_default()
                                .to_string();
                            if let Some(p) = op["submask"].get_mut("parameters") {
                                parameters(&kind, p, &t, &format!("{path}.submask.parameters"))?;
                            }
                        }
                        Some("edit") => {
                            let id = op["submask_id"].as_str().unwrap_or_default();
                            let kind = op["patch"]["type"]
                                .as_str()
                                .or_else(|| submask_kind(session, &mask_id, id))
                                .unwrap_or_default()
                                .to_string();
                            if let Some(p) = op["patch"].get_mut("parameters") {
                                parameters(&kind, p, &t, &format!("{path}.patch.parameters"))?;
                            }
                        }
                        _ => {}
                    }
                }
            }
        }
        _ => {
            if let Some(r) = out.get_mut("region").filter(|r| r.is_object()) {
                let x = finite(&r["x"], "region.x")?;
                let y = finite(&r["y"], "region.y")?;
                let w = finite(&r["width"], "region.width")?;
                let h = finite(&r["height"], "region.height")?;
                if x < 0.0 || y < 0.0 || x + w > t.input.0 + 1e-6 || y + h > t.input.1 + 1e-6 {
                    return Err(format!(
                        "INVALID_ARGUMENT: region is outside the {}x{} coordinate space",
                        t.input.0, t.input.1
                    ));
                }
                *r = json!({"x": t.offset.0 + x * t.scale.0, "y": t.offset.1 + y * t.scale.1,
                            "width": w * t.scale.0, "height": h * t.scale.1});
            }
            for key in ["include_points", "exclude_points"] {
                if let Some(points) = out.get_mut(key).and_then(Value::as_array_mut) {
                    for (i, point) in points.iter_mut().enumerate() {
                        pair(point, ("x", "y"), &t, true, &format!("{key}[{i}]"))?;
                    }
                }
            }
        }
    }
    let mut mapping = json!({"from": space, "to": "mask", "scale": [t.scale.0, t.scale.1],
        "offset": [t.offset.0, t.offset.1],
        "note": "Positions, rectangles, radii, brush sizes and linear fade widths were converted to the pre-crop mask canvas; grow and feather are unchanged."});
    if method == "mask_generate" {
        for key in ["region", "include_points", "exclude_points"] {
            if let Some(v) = out.get(key) {
                mapping[key] = v.clone();
            }
        }
    }
    Ok(Some((out, mapping)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(scale: f64, offset: (f64, f64)) -> Transform {
        Transform {
            scale: (scale, scale),
            offset,
            input: (1000.0, 800.0),
        }
    }

    #[test]
    fn preview_points_map_through_scale_and_crop() {
        let t = t(2.0, (300.0, 100.0));
        // Pixel centre 0 of a half-size preview covers mask pixels 300..302; its centre is 300.5.
        assert_eq!(t.point(0.0, 0.0), (300.5, 100.5));
        assert_eq!(t.point(10.0, 20.0), (320.5, 140.5));
    }

    #[test]
    fn brush_positions_and_sizes_scale() {
        let t = t(2.0, (300.0, 100.0));
        let mut p = json!({"lines":[{"tool":"brush","brushSize":20,"points":[{"x":10,"y":20}]}],"feather":0.5});
        parameters("brush", &mut p, &t, "parameters").unwrap();
        assert_eq!(p["lines"][0]["brushSize"], json!(40.0));
        assert_eq!(p["lines"][0]["points"][0], json!({"x":320.5,"y":140.5}));
        assert_eq!(p["feather"], json!(0.5));
    }

    #[test]
    fn radial_linear_and_colour_parameters_convert() {
        let t = t(2.0, (0.0, 0.0));
        let mut radial =
            json!({"centerX":10,"centerY":10,"radiusX":5,"radiusY":6,"rotation":0,"feather":0.8});
        parameters("radial", &mut radial, &t, "p").unwrap();
        assert_eq!(
            (radial["radiusX"].as_f64(), radial["radiusY"].as_f64()),
            (Some(10.0), Some(12.0))
        );
        let mut linear = json!({"startX":0,"startY":10,"endX":100,"endY":10,"range":30});
        parameters("linear", &mut linear, &t, "p").unwrap();
        assert_eq!(linear["range"], json!(60.0));
        let mut colour = json!({"targetX":5000,"targetY":5,"tolerance":10});
        assert!(
            parameters("color", &mut colour, &t, "p")
                .unwrap_err()
                .contains("outside")
        );
    }

    #[test]
    fn partial_point_patch_is_rejected() {
        let mut p = json!({"centerX":10});
        let err = parameters("radial", &mut p, &t(1.0, (0.0, 0.0)), "patch").unwrap_err();
        assert!(err.contains("together"));
    }

    #[test]
    fn subject_rectangle_maps_edges() {
        let t = t(2.0, (300.0, 100.0));
        let mut p = json!({"startX":10,"startY":20,"endX":110,"endY":70});
        parameters("ai-subject", &mut p, &t, "p").unwrap();
        assert_eq!(
            p,
            json!({"startX":320.0,"startY":140.0,"endX":520.0,"endY":240.0})
        );
    }
}
