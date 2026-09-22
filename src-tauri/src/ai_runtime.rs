//! Optional Linux CUDA inference; the bundled CPU path remains the default.
use anyhow::{Result, anyhow};
use ort::session::Session;
use serde::Serialize;
use std::{collections::BTreeMap, path::Path, sync::Mutex};

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
enum Provider {
    Cpu,
    Auto,
    Cuda,
}

#[derive(Debug, Serialize)]
struct Configuration {
    requested_provider: Provider,
    cuda_device_id: i32,
    gpu_arena_limit_mb: Option<usize>,
}

impl Configuration {
    fn parse(
        linux: bool,
        provider: Option<&str>,
        device: Option<&str>,
        memory: Option<&str>,
    ) -> Result<Self> {
        let requested_provider = match provider.unwrap_or("cpu") {
            "cpu" => Provider::Cpu,
            "auto" => Provider::Auto,
            "cuda" if linux => Provider::Cuda,
            "cuda" => {
                return Err(anyhow!(
                    "ONNX_PROVIDER_UNSUPPORTED: CUDA inference is supported on Linux only; use cpu or auto"
                ));
            }
            _ => {
                return Err(anyhow!(
                    "ONNX_PROVIDER_INVALID: RAPIDRAW_ONNX_PROVIDER must be cpu, auto or cuda"
                ));
            }
        };
        let mut config = Self {
            requested_provider,
            cuda_device_id: 0,
            gpu_arena_limit_mb: None,
        };
        if linux && requested_provider != Provider::Cpu {
            config.cuda_device_id = device.unwrap_or("0").parse::<i32>()
                .ok().filter(|id| *id >= 0)
                .ok_or_else(|| anyhow!("ONNX_PROVIDER_INVALID: RAPIDRAW_ONNX_DEVICE_ID must be a nonnegative integer"))?;
            config.gpu_arena_limit_mb = memory.map(|memory| memory.parse::<usize>()
                .ok().filter(|mb| *mb > 0 && mb.checked_mul(1024 * 1024).is_some())
                .ok_or_else(|| anyhow!("ONNX_PROVIDER_INVALID: RAPIDRAW_ONNX_GPU_MEM_LIMIT_MB must be a positive integer fitting the address space"))).transpose()?;
        }
        Ok(config)
    }
}

fn configuration() -> Result<Configuration> {
    Configuration::parse(
        cfg!(target_os = "linux"),
        std::env::var("RAPIDRAW_ONNX_PROVIDER").ok().as_deref(),
        std::env::var("RAPIDRAW_ONNX_DEVICE_ID").ok().as_deref(),
        std::env::var("RAPIDRAW_ONNX_GPU_MEM_LIMIT_MB")
            .ok()
            .as_deref(),
    )
}

#[derive(Clone, Serialize)]
struct ModelStatus {
    session_provider: Option<&'static str>,
    cuda_device_id: Option<i32>,
    initialization_fallback: Option<String>,
    compatibility_note: Option<&'static str>,
    gpu_arena_limit_mb: Option<usize>,
    error: Option<String>,
}

static MODELS: Mutex<BTreeMap<String, ModelStatus>> = Mutex::new(BTreeMap::new());

fn cpu_compatibility_note(model: &str) -> Option<&'static str> {
    use crate::ai_processing::{
        DECODER_FILENAME, DENOISE_FILENAME, DEPTH_FILENAME, ENCODER_FILENAME, LAMA_FILENAME,
        SKYSEG_FILENAME, U2NETP_FILENAME,
    };
    match model {
        ENCODER_FILENAME | DECODER_FILENAME => Some(
            "Bundled quantized SAM models use CPU to avoid large GPU arenas and repeated transfers for CPU integer operators",
        ),
        LAMA_FILENAME => Some(
            "Bundled FP16 LaMa uses CPU to preserve finite output at the supported maximum inpainting size",
        ),
        DENOISE_FILENAME | DEPTH_FILENAME | SKYSEG_FILENAME | U2NETP_FILENAME => None,
        _ => Some("This model has not been validated with the CUDA policy and uses CPU"),
    }
}

fn default_gpu_arena_mb(model: &str) -> usize {
    if model == crate::ai_processing::DENOISE_FILENAME {
        8192
    } else {
        2048
    }
}

/// Narrow convolution-search exception: only the NIND denoise model uses
/// ORT's default cuDNN algorithm search. Under cuDNN 9.20 the HEURISTIC
/// search deterministically requests an oversized repeat allocation for
/// NIND's transposed-convolution nodes on second inference, while DEFAULT
/// stays stable and within strict numerical gates. Foreground, sky and
/// depth keep HEURISTIC; Nonlocal has its own provider construction.
#[cfg_attr(
    not(any(target_os = "linux", test)),
    allow(dead_code, reason = "CUDA session construction is Linux-only")
)]
pub(crate) fn use_default_cudnn_search(model: &str) -> bool {
    model == crate::ai_processing::DENOISE_FILENAME
}

#[cfg(any(all(target_os = "macos", target_arch = "aarch64"), test))]
fn apple_silicon_lama_cpu_threads(
    apple_silicon: bool,
    cpu: bool,
    model: &str,
    build_info: &str,
) -> Option<usize> {
    // The official 1.30.0 archive reports HEAD rather than its release tag.
    // Limit this FP16 MatMul workaround to the verified release commit.
    let affected_runtime = build_info.split(',').any(|field| {
        matches!(
            field.trim().strip_prefix("git-commit-id="),
            Some("f2c39fe" | "f2c39fe2f838cf35ce7da92824f5a5e3ee6e88a7")
        )
    });
    (apple_silicon && cpu && model == crate::ai_processing::LAMA_FILENAME && affected_runtime)
        .then_some(4)
}

#[cfg(any(target_os = "linux", test))]
pub(crate) fn validate_inpaint_output(values: impl Iterator<Item = f32>) -> Result<()> {
    if values.into_iter().any(|value| !value.is_finite()) {
        return Err(anyhow!(
            "ONNX_INVALID_OUTPUT: Inpainting produced non-finite pixel values"
        ));
    }
    Ok(())
}

fn load_with_policy<T>(
    provider: Provider,
    mut load: impl FnMut(bool) -> Result<T>,
) -> Result<(T, &'static str, Option<String>)> {
    if provider == Provider::Cpu {
        return Ok((load(false)?, "cpu", None));
    }
    match load(true) {
        Ok(session) => Ok((session, "cuda", None)),
        Err(error) if provider == Provider::Auto => {
            let reason = error.to_string();
            log::warn!("ONNX CUDA initialization failed; using CPU: {reason}");
            Ok((load(false)?, "cpu", Some(reason)))
        }
        Err(error) => Err(anyhow!(
            "ONNX_CUDA_UNAVAILABLE: {error}. Check the GPU ONNX runtime and CUDA/cuDNN libraries, or explicitly select RAPIDRAW_ONNX_PROVIDER=cpu"
        )),
    }
}

/// All AI models share the same per-session policy except for a narrowly
/// validated NIND convolution-search exception (see
/// [`use_default_cudnn_search`]), including background workers.
/// Fallback only happens during initialization; failed inference is never replayed.
pub(crate) fn load_session(path: impl AsRef<Path>) -> Result<Session> {
    let path = path.as_ref();
    let config = configuration()?;
    let model = path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned();
    let compatibility_note =
        if cfg!(target_os = "linux") && config.requested_provider != Provider::Cpu {
            cpu_compatibility_note(&model)
        } else {
            None
        };
    let arena_mb = config
        .gpu_arena_limit_mb
        .unwrap_or_else(|| default_gpu_arena_mb(&model));
    let provider = if cfg!(target_os = "linux") && compatibility_note.is_none() {
        config.requested_provider
    } else {
        Provider::Cpu
    };
    let loaded = load_with_policy(provider, |cuda| {
        let builder = Session::builder()?;
        #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
        let builder = if let Some(threads) =
            apple_silicon_lama_cpu_threads(true, !cuda, &model, ort::info())
        {
            // KleidiAI's FP16 broadcast matrix kernels are slow for LaMa's FFT
            // graph on this runtime. Keep this setting local to the LaMa session.
            log::info!(
                "ONNX LaMa: applying ONNX Runtime 1.30.0 CPU compatibility settings (KleidiAI disabled, {threads} threads)"
            );
            builder
                .with_config_entry("mlas.disable_kleidiai", "1")?
                .with_intra_threads(threads)?
        } else {
            builder
        };
        #[cfg(target_os = "linux")]
        let builder = if cuda {
            use ort::execution_providers::{
                ArenaExtendStrategy,
                cuda::{CUDAExecutionProvider, CuDNNConvAlgorithmSearch},
            };
            builder.with_execution_providers([CUDAExecutionProvider::default()
                .with_device_id(config.cuda_device_id)
                .with_memory_limit(arena_mb * 1024 * 1024)
                .with_arena_extend_strategy(ArenaExtendStrategy::SameAsRequested)
                .with_conv_algorithm_search(if use_default_cudnn_search(&model) {
                    CuDNNConvAlgorithmSearch::Default
                } else {
                    CuDNNConvAlgorithmSearch::Heuristic
                })
                .with_conv_max_workspace(false)
                .with_tf32(false)
                .build()
                .error_on_failure()])?
        } else {
            builder
        };
        #[cfg(not(target_os = "linux"))]
        if cuda {
            return Err(anyhow!("CUDA inference is supported on Linux only"));
        }
        Ok(builder.commit_from_file(path)?)
    });
    let mut statuses = MODELS.lock().unwrap_or_else(|poison| poison.into_inner());
    match loaded {
        Ok((session, selected, fallback)) => {
            log::info!("ONNX model {model}: {selected} session provider");
            statuses.insert(
                model,
                ModelStatus {
                    session_provider: Some(selected),
                    cuda_device_id: (selected == "cuda").then_some(config.cuda_device_id),
                    initialization_fallback: fallback,
                    compatibility_note,
                    gpu_arena_limit_mb: (selected == "cuda").then_some(arena_mb),
                    error: None,
                },
            );
            Ok(session)
        }
        Err(error) => {
            statuses.insert(
                model,
                ModelStatus {
                    session_provider: None,
                    cuda_device_id: None,
                    initialization_fallback: None,
                    compatibility_note,
                    gpu_arena_limit_mb: None,
                    error: Some(error.to_string()),
                },
            );
            Err(error)
        }
    }
}

/// Inspect configuration and loaded sessions without initializing the runtime.
#[cfg(feature = "mcp")]
pub(crate) fn status() -> serde_json::Value {
    let models = MODELS.lock().unwrap_or_else(|poison| poison.into_inner());
    let (config, error) = match configuration() {
        Ok(config) => (Some(config), None),
        Err(error) => (None, Some(error.to_string())),
    };
    serde_json::json!({
        "configuration": config,
        "configuration_error": error,
        "cuda_supported_platform": cfg!(target_os = "linux"),
        "models": *models,
        "model_status_scope": "Last initialization attempt per model; this is not a live memory-residency inventory",
        "provider_scope": "Per-model session registration; unsupported operators may execute on CPU within a CUDA session",
        "memory_limit_scope": "Per-session CUDA arena, not a total GPU memory limit; other sessions and allocations outside the arena also consume memory",
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lama_cpu_workaround_is_limited_to_the_tested_apple_silicon_runtime() {
        use crate::ai_processing::{ENCODER_FILENAME, LAMA_FILENAME};
        let affected = "ORT Build Info: git-branch=HEAD, git-commit-id=f2c39fe, build type=Release";
        assert_eq!(
            apple_silicon_lama_cpu_threads(true, true, LAMA_FILENAME, affected),
            Some(4)
        );
        assert_eq!(
            apple_silicon_lama_cpu_threads(
                true,
                true,
                LAMA_FILENAME,
                "ORT Build Info: git-branch=HEAD, git-commit-id=f2c39fe2f838cf35ce7da92824f5a5e3ee6e88a7, build type=Release"
            ),
            Some(4)
        );
        for (apple_silicon, cpu, model, build_info) in [
            (false, true, LAMA_FILENAME, affected),
            (true, false, LAMA_FILENAME, affected),
            (true, true, ENCODER_FILENAME, affected),
            (true, true, LAMA_FILENAME, "git-branch=rel-1.22.0"),
            (true, true, LAMA_FILENAME, "git-branch=rel-1.31.0"),
            (true, true, LAMA_FILENAME, "git-commit-id=f2c39fe0"),
            (true, true, LAMA_FILENAME, ""),
        ] {
            assert_eq!(
                apple_silicon_lama_cpu_threads(apple_silicon, cpu, model, build_info),
                None
            );
        }
    }

    #[test]
    fn default_cpu_ignores_unrelated_cuda_options_on_every_platform() {
        for linux in [false, true] {
            for provider in [None, Some("cpu")] {
                let config =
                    Configuration::parse(linux, provider, Some("invalid"), Some("invalid"))
                        .unwrap();
                assert_eq!(config.requested_provider, Provider::Cpu);
            }
        }
    }

    #[test]
    fn cuda_is_linux_only_and_options_are_validated_when_used() {
        assert!(
            Configuration::parse(false, Some("cuda"), None, None)
                .unwrap_err()
                .to_string()
                .contains("UNSUPPORTED")
        );
        assert!(
            Configuration::parse(false, Some("auto"), Some("invalid"), Some("invalid")).is_ok()
        );
        assert!(Configuration::parse(true, Some("cdua"), None, None).is_err());
        for value in ["-1", "1.5", "", "2147483648"] {
            assert!(Configuration::parse(true, Some("cuda"), Some(value), None).is_err());
        }
        for value in ["-1", "0", "1.5", "", "18446744073709551615"] {
            assert!(Configuration::parse(true, Some("auto"), None, Some(value)).is_err());
        }
        let config = Configuration::parse(true, Some("cuda"), Some("1"), Some("4096")).unwrap();
        assert_eq!(config.cuda_device_id, 1);
        assert_eq!(config.gpu_arena_limit_mb, Some(4096));
    }

    #[test]
    fn bundled_models_keep_known_compatibility_paths_and_memory_budgets() {
        use crate::ai_processing::*;
        for model in [ENCODER_FILENAME, DECODER_FILENAME, LAMA_FILENAME] {
            assert!(cpu_compatibility_note(model).is_some());
        }
        for model in [
            DENOISE_FILENAME,
            U2NETP_FILENAME,
            SKYSEG_FILENAME,
            DEPTH_FILENAME,
        ] {
            assert!(cpu_compatibility_note(model).is_none());
        }
        assert_eq!(default_gpu_arena_mb(DENOISE_FILENAME), 8192);
        assert_eq!(default_gpu_arena_mb(DEPTH_FILENAME), 2048);
        assert!(cpu_compatibility_note("unvalidated-model.onnx").is_some());
    }

    #[test]
    fn nind_selects_default_cudnn_search_while_validated_models_keep_heuristic() {
        use crate::ai_processing::*;
        assert!(use_default_cudnn_search(DENOISE_FILENAME));
        for model in [U2NETP_FILENAME, SKYSEG_FILENAME, DEPTH_FILENAME] {
            assert!(!use_default_cudnn_search(model));
        }
        for model in [
            ENCODER_FILENAME,
            DECODER_FILENAME,
            LAMA_FILENAME,
            "unvalidated-model.onnx",
        ] {
            assert!(!use_default_cudnn_search(model));
        }
    }

    #[test]
    fn invalid_inpainting_values_are_rejected_before_integer_conversion() {
        assert!(validate_inpaint_output([0., 255., -1., 256.].into_iter()).is_ok());
        for value in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
            assert!(
                validate_inpaint_output([0., value].into_iter())
                    .unwrap_err()
                    .to_string()
                    .contains("ONNX_INVALID_OUTPUT")
            );
        }
    }

    #[test]
    fn cpu_policy_never_attempts_cuda() {
        let (value, provider, fallback) = load_with_policy(Provider::Cpu, |cuda| {
            assert!(!cuda);
            Ok(42)
        })
        .unwrap();
        assert_eq!((value, provider, fallback), (42, "cpu", None));
    }

    #[test]
    fn forced_cuda_errors_without_retrying_cpu() {
        let mut calls = Vec::new();
        let result = load_with_policy::<()>(Provider::Cuda, |cuda| {
            calls.push(cuda);
            Err(anyhow!("missing library"))
        });
        assert!(
            result
                .unwrap_err()
                .to_string()
                .contains("ONNX_CUDA_UNAVAILABLE")
        );
        assert_eq!(calls, [true]);
    }

    #[test]
    fn auto_records_initialization_fallback_but_does_not_retry_success() {
        let mut calls = Vec::new();
        let (_, provider, reason) = load_with_policy(Provider::Auto, |cuda| {
            calls.push(cuda);
            if cuda {
                Err(anyhow!("unsupported graph"))
            } else {
                Ok(42)
            }
        })
        .unwrap();
        assert_eq!(calls, [true, false]);
        assert_eq!(provider, "cpu");
        assert_eq!(reason.as_deref(), Some("unsupported graph"));
        let (value, provider, reason) = load_with_policy(Provider::Auto, |cuda| {
            assert!(cuda);
            Ok(42)
        })
        .unwrap();
        assert_eq!((value, provider, reason), (42, "cuda", None));
    }
}
