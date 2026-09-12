use super::*;
use crate::ai_processing::sam_refinement::{self as sam, SubjectBox, SubjectPoint};
use image::GenericImageView;

pub(super) struct Request {
    pub target: Option<(usize, usize)>,
    points: Vec<SubjectPoint>,
    bbox: Option<SubjectBox>,
    source_hash: String,
    geometry_hash: String,
    prior: Option<Vec<f32>>,
    prior_mode: &'static str,
}

fn geometry_hash(session: &Session) -> String {
    let a = &session.current().adjustments;
    let mut geometry = serde_json::Map::new();
    for key in crate::cache_utils::GEOMETRY_KEYS.iter().copied().chain([
        "orientationSteps",
        "rotation",
        "flipHorizontal",
        "flipVertical",
        "aiPatches",
    ]) {
        geometry.insert(key.into(), a[key].clone());
    }
    geometry.insert("dimensions".into(), json!(oriented_dimensions(session)));
    geometry.insert("is_raw".into(), json!(session.is_raw));
    hex::encode(Sha256::digest(serde_json::to_vec(&geometry).unwrap()))
}

fn points(params: &Value, dimensions: (u32, u32)) -> Result<Vec<SubjectPoint>> {
    let mut out: Vec<SubjectPoint> = Vec::new();
    let mut supplied = 0;
    for (key, include) in [("include_points", true), ("exclude_points", false)] {
        if let Some(values) = params.get(key) {
            let values = values
                .as_array()
                .ok_or_else(|| format!("INVALID_ARGUMENT: {key} must be an array"))?;
            supplied += values.len();
            if supplied > 64 {
                return Err("INVALID_ARGUMENT: At most 64 subject points total".into());
            }
            for value in values {
                let object = value
                    .as_object()
                    .ok_or("INVALID_ARGUMENT: point must be an object")?;
                if object.len() != 2 || !object.contains_key("x") || !object.contains_key("y") {
                    return Err("INVALID_ARGUMENT: points require exactly x and y".into());
                }
                let x = number(value, "x", -1.0, 0.0, dimensions.0.saturating_sub(1) as f64)?;
                let y = number(value, "y", -1.0, 0.0, dimensions.1.saturating_sub(1) as f64)?;
                if out
                    .iter()
                    .any(|p| p.x == x && p.y == y && p.include != include)
                {
                    return Err(
                        "INVALID_ARGUMENT: A point cannot be both included and excluded".into(),
                    );
                }
                if !out
                    .iter()
                    .any(|p| p.x == x && p.y == y && p.include == include)
                {
                    out.push(SubjectPoint { x, y, include });
                }
            }
        }
    }
    if out.len() > 64 {
        return Err("INVALID_ARGUMENT: At most 64 subject points total".into());
    }
    Ok(out)
}

pub(super) fn prepare(params: &Value, session: &Session) -> Result<Option<Request>> {
    if !["include_points", "exclude_points", "refine"]
        .iter()
        .any(|k| params.get(k).is_some())
    {
        return Ok(None);
    }
    if params["kind"] != "subject" {
        return Err(
            "INVALID_ARGUMENT: Point prompts and refinement only support kind='subject'".into(),
        );
    }
    let dimensions = oriented_dimensions(session);
    let points = points(params, dimensions)?;
    let bbox = if params.get("region").is_some() {
        Some(region(params, dimensions)?)
    } else {
        None
    };
    let target = if let Some(reference) = params.get("refine") {
        if params
            .get("expected_revision")
            .and_then(Value::as_u64)
            .is_none()
        {
            return Err("INVALID_ARGUMENT: Refinement requires expected_revision from the inspected session".into());
        }
        let object = reference
            .as_object()
            .ok_or("INVALID_ARGUMENT: refine must be an object")?;
        if object
            .keys()
            .any(|k| !["mask_id", "sub_mask_id"].contains(&k.as_str()))
        {
            return Err("INVALID_ARGUMENT: refine accepts mask_id and optional sub_mask_id".into());
        }
        let mask_id = required(reference, "mask_id")?;
        let masks = session.current().adjustments["masks"]
            .as_array()
            .ok_or("MASK_NOT_FOUND: Session contains no masks")?;
        let mi = masks
            .iter()
            .position(|m| m["id"] == mask_id)
            .ok_or("MASK_NOT_FOUND: Refinement mask is not in this session")?;
        let subs = masks[mi]["subMasks"]
            .as_array()
            .ok_or("INVALID_MASK: Missing submasks")?;
        let si = if reference.get("sub_mask_id").is_some() {
            let id = required(reference, "sub_mask_id")?;
            subs.iter()
                .position(|s| s["id"] == id)
                .ok_or("SUBMASK_NOT_FOUND: Refinement submask is not in target mask")?
        } else {
            let candidates: Vec<_> = subs
                .iter()
                .enumerate()
                .filter(|(_, s)| s["type"] == "ai-subject")
                .map(|(i, _)| i)
                .collect();
            if candidates.len() != 1 {
                return Err("INVALID_ARGUMENT: Specify sub_mask_id when target does not contain exactly one AI-subject submask".into());
            }
            candidates[0]
        };
        if subs[si]["type"] != "ai-subject" {
            return Err("INVALID_ARGUMENT: Refinement target must be an ai-subject submask".into());
        }
        Some((mi, si))
    } else {
        None
    };
    if target.is_none() && bbox.is_none() && !points.iter().any(|p| p.include) {
        return Err(
            "INVALID_ARGUMENT: A new point-guided subject needs region or include_points".into(),
        );
    }
    let source_hash = sha256_file(Path::new(&session.working_path))?;
    let geometry_hash = geometry_hash(session);
    let (prior, prior_mode) = if let Some((mi, si)) = target {
        let parameters = &session.current().adjustments["masks"][mi]["subMasks"][si]["parameters"];
        if let Some(saved) = parameters.get("samRefinement") {
            if parameters["rotation"].as_f64().unwrap_or(0.0) != 0.0
                || parameters["flipHorizontal"].as_bool().unwrap_or(false)
                || parameters["flipVertical"].as_bool().unwrap_or(false)
                || parameters["orientationSteps"].as_u64().unwrap_or(0) != 0
            {
                return Err("STALE_REFINEMENT: Submask placement changed after native SAM inference. Restore its identity placement or generate a new subject selection.".into());
            }
            if saved["sourceSha256"] != source_hash
                || saved["geometrySha256"] != geometry_hash
                || saved["canvasWidth"] != dimensions.0
                || saved["canvasHeight"] != dimensions.1
            {
                return Err("STALE_REFINEMENT: Source or full mask-canvas geometry changed. Restore the saved geometry or generate a new subject mask; crop and color edits are allowed.".into());
            }
            let bitmap = required(parameters, "maskDataBase64")?;
            if saved["maskSha256"] != hex::encode(Sha256::digest(bitmap.as_bytes())) {
                return Err(
                    "INVALID_REFINEMENT: Stored mask bitmap differs from its native SAM state"
                        .into(),
                );
            }
            (
                Some(
                    sam::decode_logits(required(saved, "logitsBase64")?)
                        .map_err(|e| format!("INVALID_REFINEMENT: {e}"))?,
                ),
                "native_logits",
            )
        } else {
            let mut mask = session.current().adjustments["masks"][mi].clone();
            let mut sub = mask["subMasks"][si].clone();
            sub["visible"] = json!(true);
            sub["invert"] = json!(false);
            sub["opacity"] = json!(100);
            sub["mode"] = json!("additive");
            // Morphology is retained on the final submask, not baked into its
            // prior as well. Only the placement of the original selection is used.
            sub["parameters"]["grow"] = json!(0);
            sub["parameters"]["feather"] = json!(0);
            mask["subMasks"] = json!([sub]);
            mask["visible"] = json!(true);
            mask["invert"] = json!(false);
            mask["opacity"] = json!(100);
            let def: MaskDefinition = serde_json::from_value(mask).map_err(|e| e.to_string())?;
            let bitmap = crate::mask_generation::generate_mask_bitmap(
                &def,
                dimensions.0,
                dimensions.1,
                1.0,
                (0.0, 0.0),
                None,
            )
            .ok_or("INVALID_REFINEMENT: Legacy submask could not be rasterized")?;
            (
                Some(sam::coverage_logit_seed(&bitmap)),
                "coverage_logit_seed",
            )
        }
    } else {
        (None, "none")
    };
    Ok(Some(Request {
        target,
        points,
        bbox,
        source_hash,
        geometry_hash,
        prior,
        prior_mode,
    }))
}

fn subject_canvas(base: &DynamicImage, adjustments: &Value, is_raw: bool) -> Result<DynamicImage> {
    // Retouch patches belong to the source before RAW normalization and warping,
    // matching render's source composition. Do not pollute the unpatched AI cache.
    let mut composite = crate::image_loader::composite_patches_on_image(base, adjustments)
        .map_err(|e| format!("PATCH_RENDER_FAILED: {e}"))?;
    if is_raw {
        crate::image_processing::apply_cpu_default_raw_processing(&mut composite);
    }
    let warped = crate::image_processing::apply_geometry_warp(composite, adjustments);
    let coarse = crate::image_processing::apply_coarse_rotation(
        warped,
        adjustments["orientationSteps"].as_u64().unwrap_or(0) as u8,
    );
    let flipped = crate::image_processing::apply_flip(
        coarse,
        adjustments["flipHorizontal"].as_bool().unwrap_or(false),
        adjustments["flipVertical"].as_bool().unwrap_or(false),
    );
    Ok(crate::image_processing::apply_rotation(
        flipped,
        adjustments["rotation"].as_f64().unwrap_or(0.0) as f32,
    )
    .into_owned())
}

impl Request {
    pub(super) fn generate(&self, bridge: &Bridge, session: &Session) -> Result<(Value, Value)> {
        let state = bridge.handle.state::<AppState>();
        let a = &session.current().adjustments;
        let (original, is_raw) = crate::get_original_image(&state)?;
        let canvas = subject_canvas(original.as_ref(), a, is_raw)?;
        let models = state
            .ai_state
            .lock()
            .map_err(|e| e.to_string())?
            .as_ref()
            .and_then(|s| s.models.clone())
            .ok_or("MODEL_NOT_INSTALLED: Subject model is not initialized")?;
        let embeddings =
            sam::canvas_embeddings(&canvas, &models.sam_encoder).map_err(|e| e.to_string())?;
        let (bitmap, logits) = sam::run_prompted_decoder(
            &models.sam_decoder,
            &embeddings,
            &self.points,
            self.bbox,
            self.prior.as_deref(),
            &canvas,
        )
        .map_err(|e| format!("MASK_GENERATION_FAILED: {e}"))?;
        if !bitmap.as_raw().iter().any(|v| *v > 0) {
            return Err("EMPTY_MASK: Model selected no subject pixels. Adjust point prompts or region; session is unchanged.".into());
        }
        let generated_statistics = mask_statistics(&bitmap);
        let mut bytes = Cursor::new(Vec::new());
        bitmap
            .write_to(&mut bytes, ImageFormat::Png)
            .map_err(|e| e.to_string())?;
        let encoded = format!(
            "data:image/png;base64,{}",
            STANDARD.encode(bytes.into_inner())
        );
        let (w, h) = canvas.dimensions();
        let bbox = self.bbox.unwrap_or(((0.0, 0.0), (w as f64, h as f64)));
        let mut state = json!({"version":1,"encoding":"f32-le-base64","logitsBase64":sam::encode_logits(&logits).map_err(|e|e.to_string())?,"sourceSha256":self.source_hash,"geometrySha256":self.geometry_hash,"maskSha256":hex::encode(Sha256::digest(encoded.as_bytes())),"canvasWidth":w,"canvasHeight":h});
        state["includePoints"] = json!(
            self.points
                .iter()
                .filter(|p| p.include)
                .map(|p| json!({"x":p.x,"y":p.y}))
                .collect::<Vec<_>>()
        );
        state["excludePoints"] = json!(
            self.points
                .iter()
                .filter(|p| !p.include)
                .map(|p| json!({"x":p.x,"y":p.y}))
                .collect::<Vec<_>>()
        );
        state["region"] = json!(
            self.bbox
                .map(|(a, b)| json!({"x":a.0,"y":a.1,"width":b.0-a.0,"height":b.1-a.1}))
        );
        let parameters = json!({"startX":bbox.0.0,"startY":bbox.0.1,"endX":bbox.1.0,"endY":bbox.1.1,"rotation":0,"flipHorizontal":false,"flipVertical":false,"orientationSteps":0,"maskDataBase64":encoded,"samRefinement":state});
        let result = json!({"mode":if self.target.is_some(){"replace_submask"}else{"new_mask"},"prior_mode":self.prior_mode,"coordinate_space":"mask","canvas_dimensions":[w,h],"include_points":self.points.iter().filter(|p|p.include).map(|p|json!({"x":p.x,"y":p.y})).collect::<Vec<_>>(),"exclude_points":self.points.iter().filter(|p|!p.include).map(|p|json!({"x":p.x,"y":p.y})).collect::<Vec<_>>(),"region":self.bbox.map(|(a,b)|json!({"x":a.0,"y":a.1,"width":b.0-a.0,"height":b.1-a.1})),"generated_submask_statistics":generated_statistics,"iterations":2,"caller_prompts_preserved":true,"source_sha256":self.source_hash,"geometry_sha256":self.geometry_hash,"prior_conversion":if self.prior_mode=="coverage_logit_seed"{Some("Approximate legacy selection opacity -> clamped log-odds -> top-left 1024 letterbox -> 256 mask input; not recovered native logits")}else{None}});
        Ok((parameters, result))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture(path: &Path) -> Session {
        let mut png = Cursor::new(Vec::new());
        GrayImage::from_pixel(100, 80, image::Luma([255]))
            .write_to(&mut png, ImageFormat::Png)
            .unwrap();
        let encoded = format!(
            "data:image/png;base64,{}",
            STANDARD.encode(png.into_inner())
        );
        let mut session = Session {
            id: "session".into(),
            source_path: path.to_string_lossy().into(),
            working_path: path.to_string_lossy().into(),
            source_sha256: "a".repeat(64),
            dimensions: (100, 80),
            is_raw: false,
            revision: 8,
            history: vec![super::super::super::sessions::Snapshot {
                label: "fixture".into(),
                adjustments: validation::default_adjustments(),
                metadata: json!({}),
            }],
            cursor: 0,
        };
        let identity = geometry_hash(&session);
        session.history[0].adjustments["masks"] = json!([{"id":"mask","name":"Subject","visible":true,"invert":false,"opacity":100,"adjustments":{"exposure":0.3},"subMasks":[{"id":"subject","type":"ai-subject","visible":true,"invert":false,"mode":"additive","parameters":{"startX":0,"startY":0,"endX":100,"endY":80,"maskDataBase64":encoded,"samRefinement":{"version":1,"encoding":"f32-le-base64","logitsBase64":sam::encode_logits(&vec![0.0;sam::LOGIT_COUNT]).unwrap(),"sourceSha256":sha256_file(path).unwrap(),"geometrySha256":identity,"maskSha256":hex::encode(Sha256::digest(encoded.as_bytes())),"canvasWidth":100,"canvasHeight":80}}}]}]);
        session
    }
    #[test]
    fn identity_allows_crop_grade_but_invalidates_geometry_patches_and_source() {
        let file = tempfile::NamedTempFile::new().unwrap();
        fs::write(file.path(), b"source bytes").unwrap();
        let mut session = fixture(file.path());
        let params = json!({"kind":"subject","expected_revision":8,"refine":{"mask_id":"mask"},"exclude_points":[{"x":4,"y":5}]});
        validation::validate_adjustments(&session.current().adjustments, session.dimensions)
            .unwrap();
        assert_eq!(
            prepare(&params, &session).unwrap().unwrap().prior_mode,
            "native_logits"
        );
        let before = geometry_hash(&session);
        session.history[0].adjustments["exposure"] = json!(1.0);
        session.history[0].adjustments["crop"] =
            json!({"x":2,"y":3,"width":50,"height":40,"unit":"px"});
        assert_eq!(geometry_hash(&session), before);
        assert!(prepare(&params, &session).is_ok());
        for (key, value) in [
            ("flipHorizontal", json!(true)),
            ("rotation", json!(3)),
            ("orientationSteps", json!(1)),
            ("transformDistortion", json!(5)),
            ("aiPatches", json!([{"id":"changed"}])),
        ] {
            let mut changed = session.clone();
            changed.history[0].adjustments[key] = value;
            assert_ne!(geometry_hash(&changed), before, "{key}");
            assert!(
                prepare(&params, &changed)
                    .err()
                    .unwrap()
                    .starts_with("STALE_REFINEMENT")
            );
        }
        fs::write(file.path(), b"changed source").unwrap();
        assert!(
            prepare(&params, &session)
                .err()
                .unwrap()
                .starts_with("STALE_REFINEMENT")
        );
    }
    #[test]
    fn refinement_reference_and_opaque_state_fail_before_inference() {
        let file = tempfile::NamedTempFile::new().unwrap();
        let session = fixture(file.path());
        for params in [
            json!({"kind":"subject","refine":{"mask_id":"mask"}}),
            json!({"kind":"subject","expected_revision":8,"refine":{"mask_id":"other"}}),
            json!({"kind":"subject","expected_revision":8,"refine":{"mask_id":"mask","sub_mask_id":"other"}}),
            json!({"kind":"sky","include_points":[{"x":1,"y":2}]}),
            json!({"kind":"subject","exclude_points":[{"x":1,"y":2}]}),
        ] {
            assert!(prepare(&params, &session).is_err());
        }
        let mut broken = session.clone();
        broken.history[0].adjustments["masks"][0]["subMasks"][0]["parameters"]["samRefinement"]["logitsBase64"] =
            json!("a".repeat(sam::LOGIT_BASE64_LENGTH));
        assert!(
            validation::validate_adjustments(&broken.current().adjustments, broken.dimensions)
                .is_err()
        );
        let mut legacy = session;
        legacy.history[0].adjustments["masks"][0]["subMasks"][0]["parameters"]
            .as_object_mut()
            .unwrap()
            .remove("samRefinement");
        let prepared=prepare(&json!({"kind":"subject","expected_revision":8,"refine":{"mask_id":"mask"},"exclude_points":[{"x":1,"y":2}]}),&legacy).unwrap().unwrap();
        assert_eq!(prepared.prior_mode, "coverage_logit_seed");
    }
    #[test]
    fn decimal_encoded_canvas_dimensions_return_validation_errors() {
        let file = tempfile::NamedTempFile::new().unwrap();
        let session = fixture(file.path());
        validation::validate_adjustments(&session.current().adjustments, session.dimensions)
            .unwrap();
        for key in ["canvasWidth", "canvasHeight"] {
            let mut changed = session.clone();
            let saved = &mut changed.history[0].adjustments["masks"][0]["subMasks"][0]["parameters"]
                ["samRefinement"];
            saved[key] = json!(saved[key].as_u64().unwrap() as f64);
            assert!(saved[key].as_u64().is_none());
            let error = validation::validate_adjustments(
                &changed.current().adjustments,
                changed.dimensions,
            )
            .unwrap_err();
            assert!(error.contains(key) && error.contains("unsigned JSON integer"));
        }
        for invalid in [json!(0), json!(0.5), json!(-1), json!(100001)] {
            let mut changed = session.clone();
            changed.history[0].adjustments["masks"][0]["subMasks"][0]["parameters"]["samRefinement"]
                ["canvasWidth"] = invalid;
            assert!(
                validation::validate_adjustments(
                    &changed.current().adjustments,
                    changed.dimensions
                )
                .is_err()
            );
        }
    }
    #[test]
    fn native_prior_rejects_submask_placement_changes() {
        let file = tempfile::NamedTempFile::new().unwrap();
        let session = fixture(file.path());
        let params = json!({"kind":"subject","expected_revision":8,"refine":{"mask_id":"mask"},"exclude_points":[{"x":4,"y":5}]});
        for (key, value) in [
            ("rotation", json!(2)),
            ("flipHorizontal", json!(true)),
            ("flipVertical", json!(true)),
            ("orientationSteps", json!(1)),
        ] {
            let mut changed = session.clone();
            changed.history[0].adjustments["masks"][0]["subMasks"][0]["parameters"][key] = value;
            assert!(
                prepare(&params, &changed)
                    .err()
                    .unwrap()
                    .starts_with("STALE_REFINEMENT"),
                "{key}"
            );
        }
    }
    #[test]
    fn legacy_prior_does_not_bake_preserved_morphology_twice() {
        let file = tempfile::NamedTempFile::new().unwrap();
        let mut session = fixture(file.path());
        let parameters =
            &mut session.history[0].adjustments["masks"][0]["subMasks"][0]["parameters"];
        parameters.as_object_mut().unwrap().remove("samRefinement");
        let bitmap = GrayImage::from_fn(100, 80, |x, y| {
            image::Luma([if (35..65).contains(&x) && (20..60).contains(&y) {
                255
            } else {
                0
            }])
        });
        let mut png = Cursor::new(Vec::new());
        bitmap.write_to(&mut png, ImageFormat::Png).unwrap();
        parameters["maskDataBase64"] = json!(format!(
            "data:image/png;base64,{}",
            STANDARD.encode(png.into_inner())
        ));
        let params = json!({"kind":"subject","expected_revision":8,"refine":{"mask_id":"mask"},"exclude_points":[{"x":4,"y":5}]});
        let plain = prepare(&params, &session).unwrap().unwrap().prior.unwrap();
        session.history[0].adjustments["masks"][0]["subMasks"][0]["parameters"]["grow"] = json!(80);
        session.history[0].adjustments["masks"][0]["subMasks"][0]["parameters"]["feather"] =
            json!(70);
        let adjusted = prepare(&params, &session).unwrap().unwrap().prior.unwrap();
        assert_eq!(plain, adjusted);
        assert_eq!(
            session.current().adjustments["masks"][0]["subMasks"][0]["parameters"]["grow"],
            80
        );
    }
    #[test]
    fn canvas_composites_patch_before_raw_defaults_and_native_orientation() {
        let base = DynamicImage::ImageRgb32F(image::ImageBuffer::from_pixel(
            16,
            12,
            image::Rgb([0.1, 0.2, 0.3]),
        ));
        let mut color = Cursor::new(Vec::new());
        image::RgbImage::from_pixel(2, 2, image::Rgb([200, 50, 30]))
            .write_to(&mut color, ImageFormat::Png)
            .unwrap();
        let mut mask = Cursor::new(Vec::new());
        GrayImage::from_pixel(2, 2, image::Luma([255]))
            .write_to(&mut mask, ImageFormat::Png)
            .unwrap();
        let mut a = validation::default_adjustments();
        a["aiPatches"] = json!([{"visible":true,"patchData":{"offsetX":3,"offsetY":4,"isSrgbEncoded":true,"color":STANDARD.encode(color.into_inner()),"mask":STANDARD.encode(mask.into_inner())}}]);
        a["orientationSteps"] = json!(1);
        a["flipHorizontal"] = json!(true);
        a["crop"] = json!({"x":1,"y":1,"width":4,"height":5,"unit":"px"});
        a["exposure"] = json!(2);
        let canvas = subject_canvas(&base, &a, true).unwrap().to_rgb32f();
        assert_eq!(canvas.dimensions(), (12, 16));
        let linear = |v: u8| {
            let s = v as f32 / 255.0;
            if s <= 0.04045 {
                s / 12.92
            } else {
                ((s + 0.055) / 1.055).powf(2.4)
            }
        };
        let mut expected = DynamicImage::ImageRgb32F(image::ImageBuffer::from_pixel(
            1,
            1,
            image::Rgb([linear(200), linear(50), linear(30)]),
        ));
        crate::image_processing::apply_cpu_default_raw_processing(&mut expected);
        let expected = expected.to_rgb32f();
        for c in 0..3 {
            assert!((canvas[(4, 3)][c] - expected[(0, 0)][c]).abs() < 0.00001);
        }
        let mut hidden = a;
        hidden["aiPatches"][0]["visible"] = json!(false);
        let unpatched = subject_canvas(&base, &hidden, true).unwrap().to_rgb32f();
        assert!((canvas[(4, 3)][0] - unpatched[(4, 3)][0]).abs() > 0.1);
        assert_eq!(canvas[(0, 0)], unpatched[(0, 0)]);
    }
    #[test]
    fn points_reject_bounds_conflicts_and_total_limits() {
        assert!(
            points(
                &json!({"include_points":[{"x":4,"y":2}],"exclude_points":[{"x":4,"y":2}]}),
                (100, 80)
            )
            .is_err()
        );
        assert!(points(&json!({"include_points":[{"x":100,"y":2}]}), (100, 80)).is_err());
        assert!(points(&json!({"include_points":[{"x":4}]}), (100, 80)).is_err());
        let include: Vec<_> = (0..40).map(|x| json!({"x":x,"y":1})).collect();
        let exclude: Vec<_> = (0..40).map(|x| json!({"x":x,"y":2})).collect();
        assert!(
            points(
                &json!({"include_points":include,"exclude_points":exclude}),
                (100, 80)
            )
            .is_err()
        );
        assert_eq!(
            points(
                &json!({"include_points":[{"x":4,"y":2},{"x":4,"y":2}]}),
                (100, 80)
            )
            .unwrap()
            .len(),
            1
        );
    }
}
