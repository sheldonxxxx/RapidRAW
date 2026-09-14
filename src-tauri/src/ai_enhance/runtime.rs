use anyhow::{Result, anyhow, bail};
use ort::session::Session;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    sync::Mutex,
    time::Instant,
};

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    #[default]
    Auto,
    Cpu,
    Coreml,
    Cuda,
}

struct Cached {
    path: PathBuf,
    hash: String,
    requested: Provider,
    session: Session,
    receipt: Value,
}
static CACHE: Mutex<Option<Cached>> = Mutex::new(None);

pub fn clear() {
    *CACHE.lock().unwrap_or_else(|p| p.into_inner()) = None;
}
pub fn providers() -> Vec<&'static str> {
    let mut providers = vec!["auto", "cpu"];
    if cfg!(target_os = "macos") {
        providers.push("coreml");
    }
    if cfg!(target_os = "linux") {
        providers.push("cuda");
    }
    providers
}
pub fn status() -> Value {
    match CACHE.try_lock() {
        Ok(cache) => {
            json!({"busy":false,"cached_model":cache.as_ref().map(|c|c.path.file_name().unwrap_or_default().to_string_lossy()),"policy":"One enhancement session resident at a time; changing models releases the previous session"})
        }
        Err(_) => json!({"busy":true,"policy":"One enhancement session resident at a time"}),
    }
}

fn load(path: &Path, provider: Provider) -> Result<Session> {
    // Provider registration can emit logs before Session creates its implicit
    // environment. Register the process logger first, including CUDA startup.
    let _ = ort::init().with_name("Photo-Enhancement").commit()?;
    if provider == Provider::Coreml
        && path.file_name().and_then(|n| n.to_str()) != Some("vitmatte-small-f32.onnx")
    {
        bail!(
            "ONNX_PROVIDER_UNSUPPORTED: CoreML is validated only for ViTMatte. Face parsing can abort inside MPSGraph; use CPU on macOS for this model"
        );
    }
    let threads = std::thread::available_parallelism().map_or(2, |n| n.get().min(4));
    let mut builder = Session::builder()?
        .with_intra_threads(threads)?
        .with_memory_pattern(false)?;
    match provider {
        Provider::Cpu => {}
        Provider::Coreml => {
            #[cfg(target_os = "macos")]
            {
                use ort::execution_providers::coreml::{
                    CoreMLExecutionProvider, CoreMLModelFormat,
                };
                let cache = path.parent().unwrap_or(Path::new(".")).join("coreml-cache");
                std::fs::create_dir_all(&cache)?;
                builder = builder.with_execution_providers([CoreMLExecutionProvider::default()
                    .with_model_format(CoreMLModelFormat::MLProgram)
                    .with_model_cache_dir(cache.to_string_lossy())
                    .build()
                    .error_on_failure()])?;
            }
            #[cfg(not(target_os = "macos"))]
            bail!("ONNX_PROVIDER_UNSUPPORTED: CoreML requires macOS");
        }
        Provider::Cuda => {
            #[cfg(target_os = "linux")]
            {
                use ort::execution_providers::{
                    ArenaExtendStrategy,
                    cuda::{CUDAExecutionProvider, CuDNNConvAlgorithmSearch},
                };
                builder = builder.with_execution_providers([CUDAExecutionProvider::default()
                    .with_memory_limit(4096 * 1024 * 1024)
                    .with_arena_extend_strategy(ArenaExtendStrategy::SameAsRequested)
                    .with_conv_algorithm_search(CuDNNConvAlgorithmSearch::Heuristic)
                    .with_conv_max_workspace(false)
                    .with_tf32(false)
                    .build()
                    .error_on_failure()])?;
            }
            #[cfg(not(target_os = "linux"))]
            bail!("ONNX_PROVIDER_UNSUPPORTED: CUDA requires the Linux GPU runtime");
        }
        Provider::Auto => bail!("Auto provider must be resolved before loading"),
    }
    Ok(builder.commit_from_file(path)?)
}

pub fn with_session<T, U>(
    path: &Path,
    hash: &str,
    requested: Provider,
    f: impl FnOnce(&mut Session) -> Result<(T, U)>,
) -> Result<(T, U, Value)> {
    let mut cache = CACHE
        .try_lock()
        .map_err(|_| anyhow!("ENHANCEMENT_BUSY: Another enhancement is running"))?;
    let hit = cache
        .as_ref()
        .is_some_and(|c| c.path == path && c.hash == hash && c.requested == requested);
    let started = Instant::now();
    if !hit {
        *cache = None;
        let candidate = match requested {
            Provider::Auto if cfg!(target_os = "macos") => Provider::Cpu,
            Provider::Auto if cfg!(target_os = "linux") => Provider::Cuda,
            Provider::Auto => Provider::Cpu,
            other => other,
        };
        let (session, selected, fallback) = match load(path, candidate) {
            Ok(session) => (session, candidate, None),
            Err(error) if requested == Provider::Auto && candidate != Provider::Cpu => (
                load(path, Provider::Cpu)?,
                Provider::Cpu,
                Some(error.to_string()),
            ),
            Err(error) => return Err(error),
        };
        *cache = Some(Cached {
            path: path.to_path_buf(),
            hash: hash.into(),
            requested,
            session,
            receipt: json!({"session_provider":selected,"initialization_fallback":fallback,"provider_scope":"Registered execution provider; unsupported operators may execute on CPU","cpu_threads":std::thread::available_parallelism().map_or(2,|n|n.get().min(4)),"cuda_arena_limit_mb":if selected==Provider::Cuda {Some(4096)} else {None}}),
        });
    }
    let cached = cache.as_mut().unwrap();
    let mut receipt = cached.receipt.clone();
    receipt["onnx_build"] = json!(ort::info());
    receipt["cache_hit"] = json!(hit);
    receipt["load_ms"] = json!(started.elapsed().as_millis());
    let inference = Instant::now();
    let (one, two) = f(&mut cached.session)?;
    receipt["processing_ms"] = json!(inference.elapsed().as_millis());
    Ok((one, two, receipt))
}
