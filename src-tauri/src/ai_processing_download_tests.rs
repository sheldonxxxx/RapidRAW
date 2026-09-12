//! Controlled localhost transport faults. These test the real downloader, not MCP or inference.
use super::{download_model, download_verified_model, verify_sha256};
use sha2::{Digest, Sha256};
use std::{fs, path::Path, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

async fn response_server(
    status: u16,
    payload: &'static [u8],
    declared_length: usize,
    stall: bool,
) -> (String, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/fixture.onnx", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut request = [0u8; 4096];
        assert!(
            stream.read(&mut request).await.unwrap() > 0,
            "Client must send an HTTP request"
        );
        let header = format!(
            "HTTP/1.1 {status} Test\r\nContent-Length: {declared_length}\r\nConnection: close\r\n\r\n"
        );
        stream.write_all(header.as_bytes()).await.unwrap();
        stream.write_all(payload).await.unwrap();
        if stall {
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
        let _ = stream.shutdown().await;
    });
    (url, task)
}

fn hash(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

async fn assert_explicit_retry(path: &Path) {
    let payload = b"verified model fixture";
    let (url, task) = response_server(200, payload, payload.len(), false).await;
    download_verified_model(&url, path, &hash(payload))
        .await
        .unwrap();
    task.await.unwrap();
    assert!(verify_sha256(path, &hash(payload)).unwrap());
    assert_eq!(fs::read(path).unwrap(), payload);
}

#[tokio::test]
async fn unavailable_network_does_not_publish_and_explicit_retry_succeeds() {
    let directory = tempfile::tempdir().unwrap();
    let destination = directory.path().join("model.onnx");
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/offline", listener.local_addr().unwrap());
    drop(listener);
    assert!(download_model(&url, &destination).await.is_err());
    assert!(!destination.exists());
    assert_explicit_retry(&destination).await;
}

#[tokio::test]
async fn http_failure_preserves_existing_asset_and_explicit_retry_succeeds() {
    let directory = tempfile::tempdir().unwrap();
    let destination = directory.path().join("model.onnx");
    fs::write(&destination, b"existing verified asset").unwrap();
    let (url, task) = response_server(503, b"offline", 7, false).await;
    assert!(
        download_verified_model(&url, &destination, &hash(b"replacement"))
            .await
            .is_err()
    );
    task.await.unwrap();
    assert_eq!(fs::read(&destination).unwrap(), b"existing verified asset");
    assert_explicit_retry(&destination).await;
}

#[tokio::test]
async fn truncated_body_never_publishes_partial_file() {
    let directory = tempfile::tempdir().unwrap();
    let destination = directory.path().join("model.onnx");
    let (url, task) = response_server(200, b"partial", 1024, false).await;
    assert!(
        download_verified_model(&url, &destination, &hash(b"complete"))
            .await
            .is_err()
    );
    task.await.unwrap();
    assert!(!destination.exists());
    assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 0);
    assert_explicit_retry(&destination).await;
}

#[tokio::test]
async fn cancelled_download_preserves_asset_and_explicit_retry_succeeds() {
    let directory = tempfile::tempdir().unwrap();
    let destination = directory.path().join("model.onnx");
    fs::write(&destination, b"existing verified asset").unwrap();
    let (url, task) = response_server(200, b"partial", 1024, true).await;
    assert!(
        tokio::time::timeout(
            Duration::from_millis(40),
            download_verified_model(&url, &destination, &hash(b"complete"))
        )
        .await
        .is_err()
    );
    task.await.unwrap();
    assert_eq!(fs::read(&destination).unwrap(), b"existing verified asset");
    assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
    assert_explicit_retry(&destination).await;
}

#[tokio::test]
async fn hash_mismatch_never_replaces_valid_asset_and_explicit_retry_succeeds() {
    let directory = tempfile::tempdir().unwrap();
    let destination = directory.path().join("model.onnx");
    fs::write(&destination, b"existing verified asset").unwrap();
    let (url, task) = response_server(200, b"corrupt", 7, false).await;
    let error = download_verified_model(&url, &destination, &hash(b"wanted"))
        .await
        .unwrap_err();
    task.await.unwrap();
    assert!(error.to_string().contains("hash mismatch"));
    assert_eq!(fs::read(&destination).unwrap(), b"existing verified asset");
    assert_explicit_retry(&destination).await;
}
