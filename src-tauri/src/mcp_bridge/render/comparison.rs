//! Matched native previews and diagnostics. No temporary state is persisted.
use super::*;
use crate::mcp_bridge::versions::temporary_session;

fn matching_geometry(a: &Value, b: &Value) -> bool {
    // Missing values and explicit defaults are equivalent. Include warps that
    // preserve dimensions: equal canvas sizes alone do not establish alignment.
    let defaults = validation::default_adjustments();
    [
        "orientationSteps",
        "rotation",
        "flipHorizontal",
        "flipVertical",
        "crop",
        "transformDistortion",
        "transformVertical",
        "transformHorizontal",
        "transformAspect",
        "transformXOffset",
        "transformYOffset",
        "transformRotate",
        "transformScale",
        "lensDistortionEnabled",
        "lensDistortionAmount",
        "lensDistortionParams",
        "lensCorrectionMode",
        "lensMaker",
        "lensModel",
        "perspectivePoints",
        "guidedUpright",
        "uprightMode",
        "guidedPerspective",
    ]
    .iter()
    .all(|key| a.get(*key).unwrap_or(&defaults[*key]) == b.get(*key).unwrap_or(&defaults[*key]))
}

fn preview_params(params: &Value) -> Result<Value> {
    let mut result = json!({"long_edge":integer(params, "long_edge", 1200, 1, 2048)?});
    if let Some(region) = params.get("region") {
        result["region"] = region.clone();
    }
    Ok(result)
}

fn image_block(image: &DynamicImage, label: &str) -> Result<Value> {
    let bytes = encode_image_to_bytes(
        &DynamicImage::ImageRgb8(image.to_rgb8()),
        "png",
        100,
        TiffBitDepth::Eight,
    )?;
    Ok(
        json!({"label":label,"width":image.width(),"height":image.height(),"mimeType":"image/png","data":STANDARD.encode(bytes)}),
    )
}

impl Bridge {
    pub(crate) fn render_compare(&self, session: &Session, params: &Value) -> Result<Value> {
        let variants = params["variants"]
            .as_array()
            .ok_or("INVALID_ARGUMENT: variants must be an array")?;
        if !(2..=4).contains(&variants.len()) {
            return Err("INVALID_ARGUMENT: Supply 2..4 variants".into());
        }
        let preview = preview_params(params)?;
        // Validate every candidate before doing expensive rendering.
        let states = variants.iter().map(|variant| {
            let label = required(variant, "label")?;
            if label.is_empty() || label.len() > 200 { return Err("INVALID_ARGUMENT: label must contain 1..200 bytes".into()); }
            let snapshot = variant.get("version_id").map(|id| {
                self.version_snapshot(session, id.as_str().ok_or("INVALID_ARGUMENT: version_id must be a string")?)
            }).transpose()?;
            let state = temporary_session(session, snapshot, variant)?;
            if !matching_geometry(&session.current().adjustments, &state.current().adjustments) {
                return Err("GEOMETRY_MISMATCH: Comparison variants must retain the current crop and geometric transformations".into());
            }
            Ok(state)
        }).collect::<Result<Vec<_>>>()?;
        let mut response = json!({});
        let mut images = Vec::new();
        for (state, variant) in states.iter().zip(variants) {
            let frame = self.render_frame(state, &preview)?;
            if images.is_empty() {
                response = frame_info(session, &frame);
            }
            if frame.image.width() as u64 != response["width"].as_u64().unwrap()
                || frame.image.height() as u64 != response["height"].as_u64().unwrap()
            {
                return Err("GEOMETRY_MISMATCH: Rendered variants differ in dimensions".into());
            }
            let mut block = image_block(&frame.image, variant["label"].as_str().unwrap())?;
            block["version_id"] = variant["version_id"].clone();
            block["disabled_masks"] = variant["disabled_masks"].clone();
            block["patch_keys"] = json!(
                variant["patch"]
                    .as_object()
                    .map(|m| m.keys().collect::<Vec<_>>())
            );
            block["warnings"] = json!(frame.warnings);
            images.push(block);
        }
        response["images"] = json!(images);
        response["temporary"] = json!(true);
        response["saved_revision"] = json!(session.revision);
        bounded_response(response)
    }

    pub(crate) fn inspect_adjustments(&self, session: &Session, params: &Value) -> Result<Value> {
        let preview = preview_params(params)?;
        let prepared = self.prepare_render(session, false)?;
        let region = parse_region(preview.get("region"), prepared.image.dimensions())?;
        let mut before = session.clone();
        before.history = vec![session.current().clone()];
        before.cursor = 0;
        let disabled = params
            .get("disabled_masks")
            .cloned()
            .unwrap_or_else(|| json!(prepared.masks.iter().map(|m| &m.id).collect::<Vec<_>>()));
        before = temporary_session(&before, None, &json!({"disabled_masks":disabled}))?;
        let before_frame = self.render_frame(&before, &preview)?;
        let after_frame = self.render_frame(session, &preview)?;
        let gain = number(params, "difference_gain", 4.0, 1.0, 16.0)? as f32;
        let difference = difference_image(&before_frame.image, &after_frame.image, gain)?;
        let ev_range = number(params, "exposure_range", 2.0, 0.01, 20.0)? as f32;
        let (heatmap, stats) = exposure_map(&prepared.masks, &prepared.bitmaps, region, ev_range);
        let heatmap = resize_long_edge(
            DynamicImage::ImageRgb8(heatmap),
            optional_long_edge(&preview)?,
        )?;
        let mut result = frame_info(session, &after_frame);
        result["images"] = json!([
            image_block(&before_frame.image, "Selected masks disabled")?,
            image_block(&after_frame.image, "Current edit")?,
            image_block(&difference, "Absolute rendered RGB difference")?,
            image_block(&heatmap, "Combined local exposure influence")?
        ]);
        result["temporary"] = json!(true);
        result["disabled_masks"] = disabled;
        result["difference_gain"] = json!(gain);
        result["exposure_map"] = stats;
        result["exposure_map"]["global_exposure"] = json!(
            crate::image_processing::get_mask_adjustments_from_json(&prepared.adjustments).exposure
        );
        result["exposure_map"]["legend"] = json!({"blue":-ev_range,"neutral_gray":0,"red":ev_range,"units":"EV","clipped_to_legend":true});
        result["exposure_map"]["scope"] = json!(
            "Sum of enabled local exposure adjustments weighted by native mask coverage, including opacity and inversion. Excludes global exposure and other tonal controls; not a prediction of final brightness. Row means use full-resolution ROI pixels."
        );
        result["difference_scope"] = json!(
            "Absolute per-channel difference of aligned rendered display RGB, multiplied by difference_gain. Includes all effects of the disabled masks; not sensor data or an artistic quality score."
        );
        bounded_response(result)
    }
}

// Keep enough room below the bridge's 64 MiB line limit even for noisy PNGs.
fn bounded_response(result: Value) -> Result<Value> {
    if serde_json::to_vec(&result)
        .map_err(|e| e.to_string())?
        .len()
        > 60 * 1024 * 1024
    {
        return Err("PREVIEW_TOO_LARGE: Reduce long_edge or the comparison region".into());
    }
    Ok(result)
}

fn difference_image(a: &DynamicImage, b: &DynamicImage, gain: f32) -> Result<DynamicImage> {
    if a.dimensions() != b.dimensions() {
        return Err("GEOMETRY_MISMATCH: Difference images must be aligned".into());
    }
    let a = a.to_rgb32f();
    let b = b.to_rgb32f();
    Ok(DynamicImage::ImageRgb32F(image::Rgb32FImage::from_fn(
        a.width(),
        a.height(),
        |x, y| {
            image::Rgb(std::array::from_fn(|c| {
                ((a[(x, y)][c] - b[(x, y)][c]).abs() * gain).clamp(0.0, 1.0)
            }))
        },
    )))
}

fn exposure_map(
    masks: &[MaskDefinition],
    bitmaps: &[GrayImage],
    region: Roi,
    range: f32,
) -> (image::RgbImage, Value) {
    let exposures: Vec<f32> = masks
        .iter()
        .map(|m| crate::image_processing::get_mask_adjustments_from_json(&m.adjustments).exposure)
        .collect();
    let mut image = image::RgbImage::new(region.width, region.height);
    let mut min = f32::INFINITY;
    let mut max = f32::NEG_INFINITY;
    let mut sum = 0.0f64;
    let mut rows = Vec::new();
    let mut row_total = 0.0f64;
    let stride = region.height.div_ceil(128);
    let mut row_count = 0u32;
    for y in 0..region.height {
        let mut row_sum = 0.0f64;
        for x in 0..region.width {
            let ev: f32 = exposures
                .iter()
                .zip(bitmaps)
                .map(|(exposure, bitmap)| {
                    exposure * bitmap[(x + region.x, y + region.y)][0] as f32 / 255.0
                })
                .sum();
            min = min.min(ev);
            max = max.max(ev);
            row_sum += ev as f64;
            let t = (ev / range).clamp(-1.0, 1.0);
            image[(x, y)] = image::Rgb(if t >= 0.0 {
                [
                    (128.0 + 127.0 * t).round() as u8,
                    (128.0 * (1.0 - t)).round() as u8,
                    (128.0 * (1.0 - t)).round() as u8,
                ]
            } else {
                [
                    (128.0 * (1.0 + t)).round() as u8,
                    (128.0 * (1.0 + t)).round() as u8,
                    (128.0 - 127.0 * t).round() as u8,
                ]
            });
        }
        sum += row_sum;
        row_total += row_sum;
        row_count += 1;
        if row_count == stride || y + 1 == region.height {
            rows.push(json!({"y_start":region.y+y+1-row_count,"y_end_exclusive":region.y+y+1,"mean_ev":row_total/(region.width as f64*row_count as f64)}));
            row_total = 0.0;
            row_count = 0;
        }
    }
    (
        image,
        json!({"min_ev":min,"max_ev":max,"mean_ev":sum/(region.width as f64*region.height as f64),"row_profile":rows,"mask_ids":masks.iter().map(|m| &m.id).collect::<Vec<_>>()}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn differences_measure_pixels_and_reject_unaligned_dimensions() {
        let a = DynamicImage::ImageRgb32F(image::Rgb32FImage::from_pixel(
            2,
            2,
            image::Rgb([0.1, 0.5, 0.9]),
        ));
        let b = DynamicImage::ImageRgb32F(image::Rgb32FImage::from_pixel(
            2,
            2,
            image::Rgb([0.3, 0.4, 0.9]),
        ));
        let out = difference_image(&a, &b, 2.0).unwrap().to_rgb32f();
        assert!((out[(0, 0)][0] - 0.4).abs() < 1e-6);
        assert!(
            difference_image(&a, &a, 4.0)
                .unwrap()
                .to_rgb32f()
                .pixels()
                .all(|p| p.0 == [0.0; 3])
        );
        assert!(difference_image(&a, &DynamicImage::new_rgb8(1, 1), 1.0).is_err());
    }
    #[test]
    fn comparison_rejects_warps_even_on_same_canvas() {
        assert!(!matching_geometry(
            &json!({"transformVertical":10}),
            &json!({"transformVertical":20})
        ));
        assert!(matching_geometry(
            &json!({"temperature":10}),
            &json!({"temperature":20})
        ));
    }
    #[test]
    fn exposure_map_sums_native_mask_weights_in_roi() {
        let masks: Vec<MaskDefinition> = serde_json::from_value(json!([
            {"id":"a","name":"a","visible":true,"invert":false,"adjustments":{"exposure":2},"subMasks":[]},
            {"id":"b","name":"b","visible":true,"invert":false,"adjustments":{"exposure":-1},"subMasks":[]}
        ])).unwrap();
        let maps = vec![
            GrayImage::from_pixel(3, 2, Luma([128])),
            GrayImage::from_pixel(3, 2, Luma([255])),
        ];
        let (_, stats) = exposure_map(
            &masks,
            &maps,
            Roi {
                x: 1,
                y: 0,
                width: 2,
                height: 2,
            },
            2.0,
        );
        assert!((stats["mean_ev"].as_f64().unwrap() - 1.25 / 255.0).abs() < 1e-6);
        assert_eq!(stats["row_profile"][0]["y_start"], 0);
    }
}
