use super::*;
use crate::{
    app_state::{AppState, LoadedImage},
    mask_generation::MaskDefinition,
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use std::{borrow::Cow, io::Cursor, sync::atomic::Ordering};
use tauri::Manager;

pub fn check_cancelled(cancel: &AtomicBool) -> Result<()> {
    if cancel.load(Ordering::Acquire) {
        bail!("ENHANCEMENT_CANCELLED");
    }
    Ok(())
}

/// Atomically bind a request to the selected image. Rendering and parametric
/// masks must use this same snapshot even if the editor opens another photo.
pub fn capture_source(handle: &tauri::AppHandle, expected_path: &str) -> Result<LoadedImage> {
    let state = handle.state::<AppState>();
    let loaded = state
        .original_image
        .lock()
        .map_err(|e| anyhow!(e.to_string()))?
        .as_ref()
        .cloned()
        .ok_or_else(|| anyhow!("IMAGE_NOT_LOADED"))?;
    if loaded.path != expected_path {
        bail!("IMAGE_CHANGED: Selected image changed before enhancement");
    }
    Ok(loaded)
}

fn warped_reference(
    loaded: &LoadedImage,
    adjustments: &Value,
    cancel: &AtomicBool,
) -> Result<DynamicImage> {
    check_cancelled(cancel)?;
    // Match get_cached_full_warped_image's color/luminance reference without
    // reading or populating caches belonging to a newly selected photograph.
    let mut reference = Cow::Borrowed(loaded.image.as_ref());
    if loaded.is_raw {
        crate::image_processing::apply_cpu_default_raw_processing(reference.to_mut());
    }
    check_cancelled(cancel)?;
    let warped = crate::image_processing::apply_geometry_warp(reference, adjustments).into_owned();
    check_cancelled(cancel)?;
    Ok(warped)
}

/// Render the same full-precision native pipeline used for delivery. Mask
/// inference uses the oriented canvas before user crop; restoration uses the crop.
pub fn render_input(
    handle: &tauri::AppHandle,
    loaded: &LoadedImage,
    adjustments: &Value,
    full_canvas: bool,
    cancel: &AtomicBool,
) -> Result<DynamicImage> {
    check_cancelled(cancel)?;
    let state = handle.state::<AppState>();
    let mut a = adjustments.clone();
    if full_canvas {
        a["crop"] = Value::Null;
    }
    let composite = crate::image_loader::composite_patches_on_image(&loaded.image, &a)
        .map_err(|e| anyhow!(e))?;
    check_cancelled(cancel)?;
    let (image, offset) = crate::apply_all_transformations(Cow::Owned(composite), &a);
    check_cancelled(cancel)?;
    let definitions: Vec<MaskDefinition> =
        serde_json::from_value(a.get("masks").cloned().unwrap_or(json!([])))?;
    let warped = if definitions
        .iter()
        .filter(|m| m.visible)
        .any(MaskDefinition::requires_warped_image)
    {
        Some(warped_reference(loaded, &a, cancel)?)
    } else {
        None
    };
    let bitmaps = definitions
        .iter()
        .filter(|m| m.visible)
        .map(|m| {
            check_cancelled(cancel)?;
            crate::mask_generation::generate_mask_bitmap(
                m,
                image.width(),
                image.height(),
                1.0,
                (offset.0.round(), offset.1.round()),
                warped.as_ref(),
            )
            .ok_or_else(|| anyhow!("MASK_RENDER_FAILED: {}", m.id))
        })
        .collect::<Result<Vec<_>>>()?;
    check_cancelled(cancel)?;
    let context =
        crate::image_processing::get_or_init_gpu_context(&state, handle).map_err(|e| anyhow!(e))?;
    let tm =
        crate::image_processing::resolve_tonemapper_override_from_handle(handle, loaded.is_raw);
    let mut controls =
        crate::image_processing::get_all_adjustments_from_json(&a, loaded.is_raw, tm);
    controls.global.show_clipping = 0;
    let lut = a["lutPath"]
        .as_str()
        .filter(|p| !p.is_empty())
        .map(|p| crate::lut_processing::get_or_load_lut(&state, p).map_err(|e| anyhow!(e)))
        .transpose()?;
    let rendered = crate::gpu_processing::process_and_get_dynamic_image_high_precision(
        &context,
        &image,
        crate::gpu_processing::RenderRequest {
            adjustments: controls,
            mask_bitmaps: &bitmaps,
            lut,
            roi: None,
        },
    )
    .map_err(|e| anyhow!(e))?;
    check_cancelled(cancel)?;
    Ok(rendered)
}

pub fn target(
    adjustments: &Value,
    mask_id: &str,
    sub_mask_id: Option<&str>,
) -> Result<(usize, usize)> {
    let masks = adjustments["masks"]
        .as_array()
        .ok_or_else(|| anyhow!("MASK_NOT_FOUND"))?;
    let mi = masks
        .iter()
        .position(|m| m["id"] == mask_id)
        .ok_or_else(|| anyhow!("MASK_NOT_FOUND: Select a local-adjustment mask"))?;
    let subs = masks[mi]["subMasks"]
        .as_array()
        .ok_or_else(|| anyhow!("SUBMASK_NOT_FOUND"))?;
    let si = if let Some(id) = sub_mask_id {
        subs.iter()
            .position(|s| s["id"] == id)
            .ok_or_else(|| anyhow!("SUBMASK_NOT_FOUND"))?
    } else if subs.len() == 1 {
        0
    } else {
        bail!("INVALID_ARGUMENT: Select the submask to refine when a mask has multiple components")
    };
    Ok((mi, si))
}

pub fn selection(
    loaded: &LoadedImage,
    adjustments: &Value,
    indices: (usize, usize),
    dimensions: (u32, u32),
    cancel: &AtomicBool,
) -> Result<GrayImage> {
    check_cancelled(cancel)?;
    let (mi, si) = indices;
    let mut sub = adjustments["masks"][mi]["subMasks"][si].clone();
    sub["invert"] = json!(false);
    sub["opacity"] = json!(100);
    sub["visible"] = json!(true);
    sub["mode"] = json!("additive");
    let definition: MaskDefinition = serde_json::from_value(
        json!({"id":"enhancement-selection","name":"Selection","visible":true,"invert":false,"opacity":100,"adjustments":{},"subMasks":[sub]}),
    )?;
    let warped = if definition.requires_warped_image() {
        Some(warped_reference(loaded, adjustments, cancel)?)
    } else {
        None
    };
    let mask = crate::mask_generation::generate_mask_bitmap(
        &definition,
        dimensions.0,
        dimensions.1,
        1.0,
        (0., 0.),
        warped.as_ref(),
    )
    .ok_or_else(|| anyhow!("MASK_RENDER_FAILED: Cannot render selected submask"))?;
    check_cancelled(cancel)?;
    Ok(mask)
}

pub fn apply_mask(
    adjustments: &Value,
    bitmap: &GrayImage,
    indices: Option<(usize, usize)>,
    name: &str,
) -> Result<(Value, String, String)> {
    if !bitmap.as_raw().iter().any(|v| *v > 0) {
        bail!("EMPTY_MASK: Model produced an empty selection; adjustments remain unchanged");
    }
    let mut bytes = Cursor::new(Vec::new());
    bitmap.write_to(&mut bytes, image::ImageFormat::Png)?;
    // The learned output already represents the current oriented mask canvas.
    let parameters = json!({"startX":0,"startY":0,"endX":bitmap.width(),"endY":bitmap.height(),"maskDataBase64":format!("data:image/png;base64,{}",STANDARD.encode(bytes.into_inner())),"rotation":0,"orientationSteps":0,"flipHorizontal":false,"flipVertical":false,"grow":0,"feather":0});
    let mut next = adjustments.clone();
    let (id, sub_id) = if let Some((mi, si)) = indices {
        let sub = &mut next["masks"][mi]["subMasks"][si];
        sub["parameters"] = parameters;
        sub["type"] = json!("ai-subject");
        (
            next["masks"][mi]["id"].as_str().unwrap().to_string(),
            next["masks"][mi]["subMasks"][si]["id"]
                .as_str()
                .unwrap()
                .to_string(),
        )
    } else {
        if !next["masks"].is_array() {
            next["masks"] = json!([]);
        }
        if next["masks"].as_array().unwrap().len() >= 32 {
            bail!("MASK_LIMIT: At most 32 local masks");
        }
        let id = uuid::Uuid::new_v4().to_string();
        let sub_id = uuid::Uuid::new_v4().to_string();
        next["masks"].as_array_mut().unwrap().push(json!({"id":id,"name":name,"visible":true,"invert":false,"opacity":100,"adjustments":{},"subMasks":[{"id":sub_id,"type":"ai-subject","visible":true,"invert":false,"opacity":100,"mode":"additive","parameters":parameters}]}));
        (id, sub_id)
    };
    Ok((next, id, sub_id))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn replacing_one_component_preserves_mask_grade_siblings_and_composition() {
        let input = json!({"exposure":0.7,"masks":[{"id":"mask","name":"Bird","opacity":47,"invert":true,"adjustments":{"exposure":1.2},"subMasks":[{"id":"first","type":"brush","invert":true,"opacity":35,"mode":"subtractive","parameters":{}},{"id":"second","type":"all","parameters":{}}]}]});
        let (out, id, sub) = apply_mask(
            &input,
            &GrayImage::from_pixel(4, 3, image::Luma([255])),
            Some((0, 0)),
            "unused",
        )
        .unwrap();
        assert_eq!(id, "mask");
        assert_eq!(sub, "first");
        assert_eq!(
            out["masks"][0]["subMasks"][1],
            input["masks"][0]["subMasks"][1]
        );
        for key in ["adjustments", "opacity", "invert", "name"] {
            assert_eq!(out["masks"][0][key], input["masks"][0][key]);
        }
        for key in ["opacity", "invert", "mode"] {
            assert_eq!(
                out["masks"][0]["subMasks"][0][key],
                input["masks"][0]["subMasks"][0][key]
            );
        }
        assert_eq!(out["exposure"], 0.7);
    }

    #[test]
    fn color_selection_uses_captured_source_after_live_image_changes() {
        let original = image::RgbImage::from_fn(8, 4, |x, _| {
            if x < 4 {
                image::Rgb([255, 0, 0])
            } else {
                image::Rgb([0, 0, 255])
            }
        });
        let mut live = LoadedImage {
            path: "first.png".into(),
            image: std::sync::Arc::new(DynamicImage::ImageRgb8(original)),
            is_raw: false,
        };
        let captured = live.clone();
        live.image = std::sync::Arc::new(DynamicImage::ImageRgb8(image::RgbImage::from_pixel(
            8,
            4,
            image::Rgb([0, 255, 0]),
        )));
        live.path = "second.png".into();
        let adjustments = json!({"masks":[{"id":"mask","name":"Color","subMasks":[{"id":"color","type":"color","parameters":{"targetX":1,"targetY":1,"tolerance":20,"grow":0,"feather":0}}]}]});
        let mask = selection(
            &captured,
            &adjustments,
            (0, 0),
            (8, 4),
            &AtomicBool::new(false),
        )
        .unwrap();
        assert_eq!(mask.get_pixel(1, 1)[0], 255);
        assert_eq!(mask.get_pixel(6, 1)[0], 0);
        assert!(
            selection(
                &captured,
                &adjustments,
                (0, 0),
                (8, 4),
                &AtomicBool::new(true)
            )
            .is_err()
        );
        assert_eq!(live.path, "second.png");
    }

    #[test]
    fn oriented_canvas_bitmap_is_cropped_once_without_reapplying_geometry() {
        let bitmap = GrayImage::from_fn(60, 80, |x, y| image::Luma([((x + 2 * y) % 256) as u8]));
        let input = json!({"orientationSteps":1,"rotation":12,"flipHorizontal":true,"crop":{"x":8,"y":13,"width":35,"height":40},"masks":[]});
        let (next, _, _) = apply_mask(&input, &bitmap, None, "Refined").unwrap();
        let definition: MaskDefinition = serde_json::from_value(next["masks"][0].clone()).unwrap();
        let actual =
            crate::mask_generation::generate_mask_bitmap(&definition, 35, 40, 1., (8., 13.), None)
                .unwrap();
        assert_eq!(
            actual,
            image::imageops::crop_imm(&bitmap, 8, 13, 35, 40).to_image()
        );
    }
}
