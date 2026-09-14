//! Opt-in checks against caller-supplied model assets and photographs.

#[test]
#[ignore = "requires RAPIDRAW_CLIP_MODEL, RAPIDRAW_CLIP_TOKENIZER, RAPIDRAW_CLIP_FIXTURE and ORT_DYLIB_PATH"]
fn clip_tagging_runtime_regression() {
    use sha2::{Digest, Sha256};
    use std::{env, fs, sync::Mutex};

    let model = env::var("RAPIDRAW_CLIP_MODEL").expect("Set RAPIDRAW_CLIP_MODEL");
    let tokenizer = env::var("RAPIDRAW_CLIP_TOKENIZER").expect("Set RAPIDRAW_CLIP_TOKENIZER");
    let fixture = env::var("RAPIDRAW_CLIP_FIXTURE").expect("Set RAPIDRAW_CLIP_FIXTURE");
    let model_hash = hex::encode(Sha256::digest(fs::read(&model).unwrap()));
    assert_eq!(
        model_hash, "57879bb1c23cdeb350d23569dd251ed4b740a96d747c529e94a2bb8040ac5d00",
        "Use the application's verified CLIP model"
    );
    let source_before = fs::read(&fixture).unwrap();
    let photo = image::load_from_memory(&source_before).unwrap();
    ort::init()
        .with_name("Tagging-Regression")
        .commit()
        .unwrap();
    let session = Mutex::new(crate::ai_runtime::load_session(&model).unwrap());
    let tokenizer = tokenizers::Tokenizer::from_file(tokenizer).unwrap();
    let labels: Vec<String> = [
        "bird", "flower", "building", "forest", "water", "person", "mountain", "sky",
    ]
    .into_iter()
    .map(String::from)
    .collect();
    let mut tags = crate::tagging::generate_tags_with_clip(
        &photo,
        &session,
        &tokenizer,
        Some(labels.clone()),
        3,
    )
    .unwrap();
    assert!(!tags.is_empty() && tags.len() <= 3);
    assert!(tags.iter().all(|tag| labels.contains(tag)));
    tags.sort();
    assert_eq!(fs::read(&fixture).unwrap(), source_before);
    let report = serde_json::json!({
        "onnx_runtime": ort::info(), "model_sha256": model_hash,
        "source_sha256": hex::encode(Sha256::digest(&source_before)), "tags": tags,
        "scope": "Native desktop tagging function with fixed candidate labels; source unchanged"
    });
    if let Ok(path) = env::var("RAPIDRAW_CLIP_REPORT") {
        fs::write(path, serde_json::to_vec_pretty(&report).unwrap()).unwrap();
    }
    println!("{report}");
}
