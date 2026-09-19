#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Linux x86_64 only: discover the optional NVIDIA runtime pack and
    // re-exec with its libraries before any Tauri or ONNX initialization.
    // No-op on other platforms; never spawns a lingering parent process.
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    rapidraw_lib::linux_nvidia_runtime::maybe_activate();
    rapidraw_lib::run();
}
