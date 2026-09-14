use super::*;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use image::ImageEncoder;
use std::{
    collections::BTreeMap,
    io::Cursor,
    sync::{Arc, Mutex, atomic::Ordering},
};
use tauri::{Emitter, Manager};

static JOBS: Mutex<BTreeMap<String, Arc<AtomicBool>>> = Mutex::new(BTreeMap::new());

fn directory(handle: &tauri::AppHandle) -> Result<PathBuf> {
    Ok(handle.path().app_data_dir()?.join("enhancement-models"))
}

#[tauri::command]
pub async fn enhancement_models(
    app_handle: tauri::AppHandle,
) -> std::result::Result<Value, String> {
    let path = directory(&app_handle).map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || status(&path))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn install_enhancement_model(
    app_handle: tauri::AppHandle,
    model_id: String,
    path: Option<String>,
    sha256: Option<String>,
) -> std::result::Result<Value, String> {
    let result = async {
        let source = path.as_deref().map(Path::new);
        let local_hash = if model(&model_id)?.sha256.is_none() && sha256.is_none() {
            source.map(digest).transpose()?
        } else {
            None
        };
        install(
            &directory(&app_handle)?,
            &model_id,
            source,
            sha256.as_deref().or(local_hash.as_deref()),
        )
        .await
    }
    .await;
    result.map_err(|e| e.to_string())
}

#[tauri::command]
pub fn cancel_enhancement(request_id: String) -> std::result::Result<(), String> {
    if let Some(token) = JOBS.lock().map_err(|e| e.to_string())?.get(&request_id) {
        token.store(true, Ordering::SeqCst);
    }
    Ok(())
}

fn preview(image: &DynamicImage) -> Result<String> {
    let image = image.thumbnail(1400, 1400).to_rgb8();
    let mut bytes = Cursor::new(Vec::new());
    image.write_to(&mut bytes, image::ImageFormat::Png)?;
    Ok(format!(
        "data:image/png;base64,{}",
        STANDARD.encode(bytes.into_inner())
    ))
}

fn write_restored_tiff(
    image: &DynamicImage,
    output: impl std::io::Write + std::io::Seek,
) -> Result<()> {
    let mut encoder = image::codecs::tiff::TiffEncoder::new(output);
    encoder.set_icc_profile(crate::color_profiles::srgb_profile().map_err(|e| anyhow!(e))?)?;
    DynamicImage::ImageRgb16(image.to_rgb16()).write_with_encoder(encoder)?;
    Ok(())
}

#[tauri::command]
pub async fn run_enhancement(
    app_handle: tauri::AppHandle,
    request_id: String,
    path: String,
    js_adjustments: Value,
    request: Request,
    mask_id: Option<String>,
    sub_mask_id: Option<String>,
) -> std::result::Result<Value, String> {
    uuid::Uuid::parse_str(&request_id)
        .map_err(|_| "INVALID_ARGUMENT: request_id must be a UUID".to_string())?;
    let token = Arc::new(AtomicBool::new(false));
    {
        let mut jobs = JOBS.lock().map_err(|e| e.to_string())?;
        if !jobs.is_empty() {
            return Err("ENHANCEMENT_BUSY: Another enhancement is running".into());
        }
        jobs.insert(request_id.clone(), token.clone());
    }
    let job_id = request_id.clone();
    let result=tauri::async_runtime::spawn_blocking(move ||->Result<Value> {
        let started=Instant::now();
        integration::check_cancelled(&token)?;
        let loaded=integration::capture_source(&app_handle,&path)?;
        let mask_operation=matches!(request.operation,Operation::RefineMask|Operation::SemanticMask);
        let indices=if request.operation==Operation::RefineMask {Some(integration::target(&js_adjustments,mask_id.as_deref().ok_or_else(||anyhow!("MASK_NOT_FOUND: Select a mask to refine"))?,sub_mask_id.as_deref())?)}else{None};
        let rendering=Instant::now();
        let image=integration::render_input(&app_handle,&loaded,&js_adjustments,mask_operation,&token)?;
        request.validate((image.width(),image.height()))?;
        let mask=indices.map(|index|integration::selection(&loaded,&js_adjustments,index,(image.width(),image.height()),&token)).transpose()?;
        let render_ms=rendering.elapsed().as_millis();
        integration::check_cancelled(&token)?;
        let before=preview(&if let Some([x,y,w,h])=request.region {image.crop_imm(x,y,w,h)}else{image.clone()})?;
        let mut progress=|value:f32|{let _=app_handle.emit("enhancement-progress",json!({"request_id":job_id,"fraction":value}));};
        let output=run(&directory(&app_handle)?,&image,mask.as_ref(),&request,&token,&mut progress)?;
        if token.load(Ordering::SeqCst){bail!("ENHANCEMENT_CANCELLED");}
        let mut result=json!({"request_id":job_id,"source_path":path,"receipt":output.receipt,"before_preview":before});
        let mut receipt_path=None;
        if let Some(bitmap)=output.mask {
            let name=if request.operation==Operation::RefineMask {"Refined mask".to_string()}else{request.classes.join(" + ")};
            let (next,id,sub)=integration::apply_mask(&js_adjustments,&bitmap,indices,&name)?;
            result["adjustments"]=next;result["mask_id"]=json!(id);result["sub_mask_id"]=json!(sub);
            result["preview"]=json!(preview(&DynamicImage::ImageLuma8(bitmap))?);
        }else if let Some(restored)=output.image {
            let directory=app_handle.path().app_data_dir()?.join("enhancements").join(&job_id);
            fs::create_dir_all(&directory)?;
            let path=directory.join("enhanced.tiff");
            let mut temporary=tempfile::NamedTempFile::new_in(&directory)?;
            write_restored_tiff(&restored,&mut temporary)?;
            temporary.as_file().sync_all()?;temporary.persist(&path).map_err(|e|e.error)?;
            receipt_path=Some(directory.join("enhancement.json"));
            result["result_path"]=json!(path);result["preview"]=json!(preview(&restored)?);
            result["edits_baked"]=json!(true);
            result["receipt"]["output_color_space"]=json!("sRGB");
            result["receipt"]["embedded_icc"]=json!(true);
        }
        result["receipt"]["render_ms"]=json!(render_ms);
        result["receipt"]["total_ms"]=json!(started.elapsed().as_millis());
        if let Some(receipt_path)=receipt_path {
            fs::write(receipt_path,serde_json::to_vec_pretty(&json!({"request_id":job_id,"source_path":path,"result_path":result["result_path"],"edits_baked":true,"receipt":result["receipt"]}))?)?;
        }
        Ok(result)
    }).await.map_err(|e|e.to_string()).and_then(|result|result.map_err(|e|e.to_string()));
    JOBS.lock().map_err(|e| e.to_string())?.remove(&request_id);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn desktop_tiff_keeps_exact_16_bit_pixels_and_embeds_srgb_icc() {
        let pixels = image::ImageBuffer::from_fn(23, 11, |x, y| {
            image::Rgb([(x * 2345 + 17) as u16, (y * 5432 + 31) as u16, 12345])
        });
        let source = DynamicImage::ImageRgb16(pixels.clone());
        let mut output = Cursor::new(Vec::new());
        write_restored_tiff(&source, &mut output).unwrap();
        let bytes = output.into_inner();
        let decoded = image::load_from_memory(&bytes).unwrap();
        assert_eq!(decoded.color(), image::ColorType::Rgb16);
        assert_eq!(decoded.to_rgb16(), pixels);
        let little = match &bytes[..4] {
            b"II\x2a\x00" => true,
            b"MM\x00\x2a" => false,
            _ => panic!("Invalid TIFF header"),
        };
        let u16_at = |at| {
            let raw = bytes[at..at + 2].try_into().unwrap();
            if little {
                u16::from_le_bytes(raw)
            } else {
                u16::from_be_bytes(raw)
            }
        };
        let u32_at = |at| {
            let raw = bytes[at..at + 4].try_into().unwrap();
            if little {
                u32::from_le_bytes(raw)
            } else {
                u32::from_be_bytes(raw)
            }
        };
        let ifd = u32_at(4) as usize;
        let count = u16_at(ifd) as usize;
        let entries: Vec<_> = (0..count)
            .map(|i| ifd + 2 + i * 12)
            .filter(|&at| u16_at(at) == 34675)
            .collect();
        assert_eq!(entries.len(), 1, "TIFF must have exactly one ICC tag");
        let entry = entries[0];
        let length = u32_at(entry + 4) as usize;
        let offset = u32_at(entry + 8) as usize;
        assert_eq!(
            &bytes[offset..offset + length],
            crate::color_profiles::srgb_profile().unwrap()
        );
    }
}
