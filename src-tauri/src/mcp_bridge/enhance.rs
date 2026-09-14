use super::{Result, required, sessions::Bridge};
use crate::ai_enhance::{self as ai, Operation, integration};
use serde_json::{Value, json};
use std::{path::Path, sync::atomic::AtomicBool};

impl Bridge {
    pub(super) fn enhancement_models(&self) -> Value {
        ai::status(&self.paths.models)
    }
    pub(super) async fn install_enhancement_model(&self, params: &Value) -> Result<Value> {
        ai::install(
            &self.paths.models,
            required(params, "model_id")?,
            params["path"].as_str().map(Path::new),
            params["sha256"].as_str(),
        )
        .await
        .map_err(|e| e.to_string())
    }
    pub(super) async fn enhance(&mut self, params: &Value) -> Result<Value> {
        let started = std::time::Instant::now();
        let parent = self.session(params)?.clone();
        if params["expected_revision"].as_u64().is_none() {
            return Err("INVALID_ARGUMENT: Enhancement requires expected_revision".into());
        }
        parent.check_revision(params)?;
        let request: ai::Request = serde_json::from_value(params["request"].clone())
            .map_err(|e| format!("INVALID_ARGUMENT: {e}"))?;
        let indices = if request.operation == Operation::RefineMask {
            Some(
                integration::target(
                    &parent.current().adjustments,
                    required(params, "mask_id")?,
                    params["sub_mask_id"].as_str(),
                )
                .map_err(|e| e.to_string())?,
            )
        } else {
            None
        };
        if request.operation != Operation::RefineMask
            && (params.get("mask_id").is_some() || params.get("sub_mask_id").is_some())
        {
            return Err("INVALID_ARGUMENT: mask references only apply to refinement".into());
        }
        ai::installed(&self.paths.models, request.model_id()).map_err(|e| e.to_string())?;
        self.activate(&parent.id).await?;
        let mask_operation = matches!(
            request.operation,
            Operation::RefineMask | Operation::SemanticMask
        );
        let cancel = AtomicBool::new(false);
        let loaded = integration::capture_source(&self.handle, &parent.working_path)
            .map_err(|e| e.to_string())?;
        let rendering = std::time::Instant::now();
        let image = integration::render_input(
            &self.handle,
            &loaded,
            &parent.current().adjustments,
            mask_operation,
            &cancel,
        )
        .map_err(|e| e.to_string())?;
        let mask = indices
            .map(|index| {
                integration::selection(
                    &loaded,
                    &parent.current().adjustments,
                    index,
                    (image.width(), image.height()),
                    &cancel,
                )
            })
            .transpose()
            .map_err(|e| e.to_string())?;
        let render_ms = rendering.elapsed().as_millis();
        let mut output = ai::run(
            &self.paths.models,
            &image,
            mask.as_ref(),
            &request,
            &cancel,
            &mut |_| {},
        )
        .map_err(|e| e.to_string())?;
        output.receipt["render_ms"] = json!(render_ms);
        if let Some(bitmap) = output.mask {
            let name = params["name"]
                .as_str()
                .map(str::to_string)
                .unwrap_or_else(|| {
                    if request.operation == Operation::RefineMask {
                        "Refined mask".into()
                    } else {
                        request.classes.join(" + ")
                    }
                });
            let (next, id, sub) =
                integration::apply_mask(&parent.current().adjustments, &bitmap, indices, &name)
                    .map_err(|e| e.to_string())?;
            output.receipt["total_ms"] = json!(started.elapsed().as_millis());
            let mut metadata = parent.current().metadata.clone();
            metadata["lastEnhancement"] = output.receipt.clone();
            let mut result = self.commit(&parent.id, next, metadata, &name)?;
            result["mask_id"] = json!(id);
            result["sub_mask_id"] = json!(sub);
            result["enhancement"] = output.receipt;
            result["mask_statistics"] = json!({"width":bitmap.width(),"height":bitmap.height(),"mean_opacity":bitmap.as_raw().iter().map(|v|f64::from(*v)/255.0).sum::<f64>()/bitmap.as_raw().len() as f64});
            Ok(result)
        } else {
            let image = output.image.ok_or("ENHANCEMENT_FAILED: No result")?;
            let result = self
                .derived(&parent, image, "Enhanced rendered photograph")
                .await?;
            let id = required(&result, "session_id")?.to_string();
            output.receipt["total_ms"] = json!(started.elapsed().as_millis());
            let mut metadata = parent.current().metadata.clone();
            metadata["mcpSourceDomain"] = json!("srgb");
            metadata["derivedFrom"] = json!({"session_id":parent.id,"revision":parent.revision,"operation":"enhance","edits_baked":true,"enhancement":output.receipt});
            self.commit(
                &id,
                super::validation::default_adjustments(),
                metadata,
                "Restoration result; parent edits retained in original session",
            )?;
            let mut result = self.sessions[&id].info(true);
            result["parent_session_id"] = json!(parent.id);
            result["enhancement"] = output.receipt;
            result["edits_baked"] = json!(true);
            result["source_domain_preserved"] = json!(false);
            Ok(result)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn generated_mask_passes_native_schema_and_renders_at_exact_canvas_size() {
        let a = super::super::validation::default_adjustments();
        let bitmap = image::GrayImage::from_fn(80, 60, |x, y| {
            image::Luma([if x > 20 && y < 45 { 255 } else { 0 }])
        });
        let (next, _, _) = integration::apply_mask(&a, &bitmap, None, "Water").unwrap();
        super::super::validation::validate_adjustments(&next, (80, 60)).unwrap();
        let mask: crate::mask_generation::MaskDefinition =
            serde_json::from_value(next["masks"][0].clone()).unwrap();
        assert_eq!(
            crate::mask_generation::generate_mask_bitmap(&mask, 80, 60, 1., (0., 0.), None)
                .unwrap(),
            bitmap
        );
    }
}
