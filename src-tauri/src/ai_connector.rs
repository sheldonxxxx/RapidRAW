use anyhow::{Result, anyhow};
use base64::{Engine as _, engine::general_purpose};
use image::{
    DynamicImage, GenericImageView, ImageFormat, RgbaImage, codecs::jpeg::JpegEncoder, imageops,
};
use reqwest::{Client, multipart};
use serde::{Deserialize, Serialize};
use std::io::Cursor;
use std::time::Duration;

pub const MAX_GENERATION_SEED: u64 = 9_007_199_254_740_991;

fn deserialize_generation_option<'de, D, T>(
    deserializer: D,
) -> std::result::Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GenerationOptions {
    #[serde(
        default,
        deserialize_with = "deserialize_generation_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub seed: Option<u64>,
    #[serde(
        default,
        deserialize_with = "deserialize_generation_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub profile: Option<String>,
    #[serde(
        default,
        deserialize_with = "deserialize_generation_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub megapixels: Option<f64>,
}

impl GenerationOptions {
    pub fn validate(&self) -> Result<()> {
        if self
            .seed
            .is_some_and(|seed| !(1..=MAX_GENERATION_SEED).contains(&seed))
        {
            return Err(anyhow!(
                "Generation seed must be an integer between 1 and {MAX_GENERATION_SEED}"
            ));
        }
        if let Some(profile) = &self.profile
            && (profile.is_empty()
                || profile.len() > 64
                || !profile.as_bytes()[0].is_ascii_alphanumeric()
                || !profile
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c)))
        {
            return Err(anyhow!(
                "Generation profile must contain 1–64 ASCII letters, digits, '.', '_' or '-', starting with a letter or digit"
            ));
        }
        if self
            .megapixels
            .is_some_and(|mp| !mp.is_finite() || !(0.0625..=16.0).contains(&mp))
        {
            return Err(anyhow!(
                "Generation megapixels must be finite and between 0.0625 and 16"
            ));
        }
        Ok(())
    }
}

#[derive(Deserialize)]
struct ConnectorCapabilities {
    protocol_version: u32,
    generation: GenerationCapabilities,
}

#[derive(Deserialize)]
struct GenerationCapabilities {
    #[serde(default)]
    seed: bool,
    #[serde(default)]
    default_profile: Option<String>,
    #[serde(default)]
    profiles: Vec<GenerationProfile>,
}

#[derive(Deserialize)]
struct GenerationProfile {
    id: String,
    #[serde(default)]
    megapixels: Vec<f64>,
}

fn validate_capabilities(
    options: &GenerationOptions,
    capabilities: &ConnectorCapabilities,
) -> Result<()> {
    options.validate()?;
    if capabilities.protocol_version != 2 {
        return Err(anyhow!(
            "AI Connector generation options require capabilities protocol version 2"
        ));
    }
    let generation = &capabilities.generation;
    if options.seed.is_some() && !generation.seed {
        return Err(anyhow!(
            "AI Connector does not support explicit generation seeds"
        ));
    }
    let profile_id = options
        .profile
        .as_deref()
        .or(generation.default_profile.as_deref());
    let profile = profile_id.and_then(|id| generation.profiles.iter().find(|p| p.id == id));
    if options.profile.is_some() && profile.is_none() {
        return Err(anyhow!(
            "AI Connector does not advertise generation profile '{}'",
            options.profile.as_deref().unwrap()
        ));
    }
    if let Some(mp) = options.megapixels {
        let profile = profile.ok_or_else(|| anyhow!("AI Connector must advertise its default profile or accept an explicit profile before setting megapixels"))?;
        if !profile
            .megapixels
            .iter()
            .any(|supported| supported.is_finite() && (*supported - mp).abs() <= 1e-9)
        {
            return Err(anyhow!(
                "AI Connector profile '{}' does not support {mp} megapixels",
                profile.id
            ));
        }
    }
    Ok(())
}

async fn check_generation_capabilities(
    client: &Client,
    base_url: &str,
    options: &GenerationOptions,
    token: Option<&str>,
) -> Result<()> {
    options.validate()?;
    let mut request = client
        .get(format!("{}/capabilities", base_url))
        .timeout(Duration::from_secs(5));
    if let Some(token) = token {
        request = request.bearer_auth(token);
    }
    let response = request
        .send()
        .await
        .map_err(|error| anyhow!("Cannot verify AI Connector generation capabilities: {error}"))?;
    if !response.status().is_success() {
        return Err(anyhow!(
            "AI Connector does not support generation options: /capabilities returned HTTP {}",
            response.status()
        ));
    }
    let capabilities = response
        .json::<ConnectorCapabilities>()
        .await
        .map_err(|error| anyhow!("Invalid AI Connector generation capabilities: {error}"))?;
    validate_capabilities(options, &capabilities)
}

#[derive(Serialize)]
struct InpaintRequest {
    source_id: String,
    prompt: String,
    negative_prompt: String,
    mask_image_base64: String,
    seed: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    profile: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    megapixels: Option<f64>,
}

#[derive(Deserialize)]
struct MiddlewareResponse {
    x: u32,
    y: u32,
    color: String,
    #[serde(default)]
    generation: Option<serde_json::Value>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GenerationContext {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GenerationMetadata {
    pub seed: u64,
    pub profile: String,
    pub source_size: [u32; 2],
    pub generated_size: [u32; 2],
    pub context: GenerationContext,
    pub seconds: f64,
    // Retained for round-tripping saved receipts from older connectors.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub processing: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tile_size: Option<u32>,
}

impl GenerationMetadata {
    pub fn validate(&self, size: [u32; 2]) -> Result<()> {
        GenerationOptions {
            seed: Some(self.seed),
            profile: Some(self.profile.clone()),
            megapixels: None,
        }
        .validate()?;
        if self.source_size != size
            || !self.seconds.is_finite()
            || !(0.0..=86400.0).contains(&self.seconds)
            || self.context.width == 0
            || self.context.height == 0
            || u64::from(self.context.x) + u64::from(self.context.width) > u64::from(size[0])
            || u64::from(self.context.y) + u64::from(self.context.height) > u64::from(size[1])
            || self.generated_size.contains(&0)
            || u64::from(self.generated_size[0]) * u64::from(self.generated_size[1]) > 100_000_000
        {
            return Err(anyhow!(
                "Generation receipt dimensions or duration are invalid"
            ));
        }
        match (self.processing.as_deref(), self.tile_size) {
            (None, None) => {}
            (Some("native_tiles"), Some(tile))
                if (64..=4096).contains(&tile)
                    && self.generated_size == [self.context.width, self.context.height] => {}
            _ => return Err(anyhow!("Generation receipt tile geometry is invalid")),
        }
        Ok(())
    }
}

#[derive(Debug)]
pub struct InpaintingOutput {
    pub image: RgbaImage,
    pub generation: Option<GenerationMetadata>,
}

// Store only the useful, bounded receipt fields. Connector logs may also contain
// private paths, prompt payloads and deployment details that do not belong in a photo.
fn generation_metadata(value: &serde_json::Value, size: [u32; 2]) -> Option<GenerationMetadata> {
    #[derive(Deserialize)]
    struct Receipt {
        seed: u64,
        profile: String,
        source_size: [u32; 2],
        generated_size: [u32; 2],
        context: serde_json::Value,
        seconds: f64,
    }
    let raw: Receipt = serde_json::from_value(value.clone()).ok()?;
    let context = GenerationContext {
        x: raw.context.get("x")?.as_u64()?.try_into().ok()?,
        y: raw.context.get("y")?.as_u64()?.try_into().ok()?,
        width: raw.context.get("width")?.as_u64()?.try_into().ok()?,
        height: raw.context.get("height")?.as_u64()?.try_into().ok()?,
    };
    let metadata = GenerationMetadata {
        seed: raw.seed,
        profile: raw.profile,
        source_size: raw.source_size,
        generated_size: raw.generated_size,
        context,
        seconds: raw.seconds,
        processing: None,
        tile_size: None,
    };
    metadata.validate(size).ok()?;
    Some(metadata)
}

#[derive(Deserialize)]
struct ConnectorHealth {
    status: String,
    connected: bool,
}

#[derive(Serialize)]
struct CloudInpaintRequest {
    image_base64: String,
    mask_image_base64: String,
    prompt: String,
    seed: i64,
}

#[derive(Deserialize)]
struct CloudInpaintResponse {
    color: String,
}

fn generate_source_id(jpeg_bytes: &[u8], dimensions: (u32, u32)) -> String {
    let mut hasher = blake3::Hasher::new();
    hasher.update(b"rapidraw-connector-source-jpeg95-v1\0");
    hasher.update(&dimensions.0.to_le_bytes());
    hasher.update(&dimensions.1.to_le_bytes());
    hasher.update(jpeg_bytes);
    hasher.finalize().to_hex().to_string()
}

fn image_to_base64(img: &DynamicImage) -> Result<String> {
    let mut buf = Cursor::new(Vec::new());
    img.write_to(&mut buf, ImageFormat::Png)?;
    Ok(general_purpose::STANDARD.encode(buf.get_ref()))
}

fn image_to_base64_jpeg(img: &DynamicImage, quality: u8) -> Result<String> {
    let mut buf = Cursor::new(Vec::new());
    let mut encoder = JpegEncoder::new_with_quality(&mut buf, quality);
    encoder.encode_image(&img.to_rgb8())?;
    Ok(general_purpose::STANDARD.encode(buf.get_ref()))
}

fn image_to_jpeg_bytes(img: &DynamicImage, quality: u8) -> Result<Vec<u8>> {
    let mut buf = Cursor::new(Vec::new());
    let mut encoder = JpegEncoder::new_with_quality(&mut buf, quality);
    encoder.encode_image(&img.to_rgb8())?;
    Ok(buf.into_inner())
}

async fn upload_source_image(
    client: &Client,
    base_url: &str,
    source_id: &str,
    jpeg_bytes: Vec<u8>,
    token: Option<&str>,
) -> Result<()> {
    let part = multipart::Part::bytes(jpeg_bytes)
        .file_name("source.jpg")
        .mime_str("image/jpeg")?;

    let form = multipart::Form::new()
        .text("source_id", source_id.to_string())
        .part("file", part);

    let mut req = client
        .post(format!("{}/upload_source", base_url))
        .multipart(form);

    if let Some(auth_token) = token {
        req = req.bearer_auth(auth_token);
    }

    let res = req.send().await?;

    if !res.status().is_success() {
        return Err(anyhow!("Upload failed: {}", res.text().await?));
    }
    Ok(())
}

fn composite_full_res(
    response: MiddlewareResponse,
    full_width: u32,
    full_height: u32,
) -> Result<RgbaImage> {
    let crop_color_bytes = general_purpose::STANDARD.decode(&response.color)?;
    let crop_color = image::load_from_memory(&crop_color_bytes)?;
    if crop_color.width() == 0
        || crop_color.height() == 0
        || u64::from(response.x) + u64::from(crop_color.width()) > u64::from(full_width)
        || u64::from(response.y) + u64::from(crop_color.height()) > u64::from(full_height)
    {
        return Err(anyhow!(
            "AI Connector returned a patch outside the source canvas"
        ));
    }

    let mut full_color = RgbaImage::new(full_width, full_height);
    imageops::overlay(
        &mut full_color,
        &crop_color,
        response.x.into(),
        response.y.into(),
    );

    Ok(full_color)
}

pub async fn check_status(address: &str) -> Result<bool> {
    let client = Client::new();
    let res = client
        .get(format!("http://{}/health", address))
        .timeout(Duration::from_secs(5))
        .send()
        .await;
    match res {
        Ok(response) if response.status().is_success() => Ok(response
            .json::<ConnectorHealth>()
            .await
            .is_ok_and(|health| health.status == "ok" && health.connected)),
        _ => Ok(false),
    }
}

pub async fn process_inpainting(
    base_url: &str,
    _source_path: &str,
    full_source_image: &DynamicImage,
    mask_image: &DynamicImage,
    prompt: String,
    token: Option<&str>,
    generation_options: Option<&GenerationOptions>,
) -> Result<InpaintingOutput> {
    let client = Client::new();
    if let Some(options) = generation_options {
        check_generation_capabilities(&client, base_url, options, token).await?;
    }
    // Prior AI patches change this prepared image without changing the RAW file.
    // Hash the exact upload bytes so cached sources follow the visible edit state.
    let jpeg_bytes = image_to_jpeg_bytes(full_source_image, 95)?;
    let source_id = generate_source_id(&jpeg_bytes, full_source_image.dimensions());
    let mask_b64 = image_to_base64(mask_image)?;
    let (w, h) = full_source_image.dimensions();

    let payload = InpaintRequest {
        source_id: source_id.clone(),
        prompt,
        negative_prompt: "blur, low quality, distortion, watermark".to_string(),
        mask_image_base64: mask_b64,
        seed: generation_options
            .and_then(|options| options.seed)
            .unwrap_or(0) as i64,
        profile: generation_options.and_then(|options| options.profile.clone()),
        megapixels: generation_options.and_then(|options| options.megapixels),
    };

    let url = format!("{}/inpaint", base_url);

    let mut req = client.post(&url).json(&payload);
    if let Some(auth_token) = token {
        req = req.bearer_auth(auth_token);
    }

    let response = req.send().await?;

    let middleware_data: MiddlewareResponse = if response.status() == 404 {
        upload_source_image(&client, base_url, &source_id, jpeg_bytes, token).await?;

        let mut retry_req = client.post(&url).json(&payload);
        if let Some(auth_token) = token {
            retry_req = retry_req.bearer_auth(auth_token);
        }

        let retry_res = retry_req.send().await?;
        if !retry_res.status().is_success() {
            return Err(anyhow!(
                "AI generation failed after upload: {}",
                retry_res.text().await?
            ));
        }
        retry_res.json().await?
    } else if !response.status().is_success() {
        return Err(anyhow!("AI generation failed: {}", response.text().await?));
    } else {
        response.json().await?
    };

    let generation = middleware_data
        .generation
        .as_ref()
        .and_then(|value| generation_metadata(value, [w, h]));
    let image = composite_full_res(middleware_data, w, h)?;
    Ok(InpaintingOutput { image, generation })
}

pub async fn process_cloud_inpainting(
    base_url: &str,
    source_crop: &DynamicImage,
    mask_crop: &DynamicImage,
    prompt: String,
    token: &str,
) -> Result<DynamicImage> {
    let client = Client::new();

    let req_payload = CloudInpaintRequest {
        image_base64: image_to_base64_jpeg(source_crop, 95)?,
        mask_image_base64: image_to_base64(mask_crop)?,
        prompt,
        seed: 0,
    };

    let res = client
        .post(format!("{}/inpaint", base_url))
        .bearer_auth(token)
        .json(&req_payload)
        .send()
        .await?;

    if !res.status().is_success() {
        return Err(anyhow!("Cloud generation failed: {}", res.text().await?));
    }

    let response: CloudInpaintResponse = res.json().await?;
    let decoded = general_purpose::STANDARD.decode(&response.color)?;

    Ok(image::load_from_memory(&decoded)?)
}

#[cfg(test)]
mod tests {
    use super::{
        ConnectorCapabilities, GenerationOptions, MAX_GENERATION_SEED, check_status,
        generate_source_id, image_to_base64, image_to_jpeg_bytes, process_inpainting,
        validate_capabilities,
    };

    #[test]
    fn generation_receipt_stores_only_bounded_display_fields() {
        let raw = serde_json::json!({"seed":104729,"profile":"balanced","source_size":[6000,4000],
            "generated_size":[1024,768],"context":{"x":100,"y":200,"width":2000,"height":1500},
            "seconds":6.2,"source_path":"/private/source.jpg","token":"must-not-be-saved","prompt":"private text"});
        let metadata = super::generation_metadata(&raw, [6000, 4000]).unwrap();
        let saved = serde_json::to_value(&metadata).unwrap();
        assert_eq!(saved["generatedSize"], serde_json::json!([1024, 768]));
        assert_eq!(saved["context"]["width"], 2000);
        assert!(
            saved.get("source_path").is_none()
                && saved.get("token").is_none()
                && saved.get("prompt").is_none()
        );
        let mut wrong = raw.clone();
        wrong["context"]["x"] = serde_json::json!(5999);
        assert!(super::generation_metadata(&wrong, [6000, 4000]).is_none());
        assert!(super::generation_metadata(&raw, [4000, 6000]).is_none());
        let mut tiles = raw.clone();
        tiles["context"]["processing"] = serde_json::json!("native_tiles");
        tiles["context"]["model_tile_size"] = serde_json::json!(1024);
        assert_eq!(
            super::generation_metadata(&tiles, [6000, 4000]).unwrap(),
            metadata
        );
        assert!(saved.get("processing").is_none() && saved.get("tileSize").is_none());
    }

    #[test]
    fn connector_patch_must_fit_the_source_canvas() {
        let pixel = image::DynamicImage::new_rgb8(4, 4);
        let color = super::image_to_base64(&pixel).unwrap();
        let response = super::MiddlewareResponse {
            x: 14,
            y: 0,
            color: color.clone(),
            generation: None,
        };
        assert!(
            super::composite_full_res(response, 16, 12)
                .unwrap_err()
                .to_string()
                .contains("outside the source canvas")
        );
        let response = super::MiddlewareResponse {
            x: 12,
            y: 8,
            color,
            generation: None,
        };
        assert_eq!(
            super::composite_full_res(response, 16, 12)
                .unwrap()
                .dimensions(),
            (16, 12)
        );
    }

    fn capabilities() -> ConnectorCapabilities {
        serde_json::from_value(serde_json::json!({
            "protocol_version":2,"generation":{"seed":true,"default_profile":"balanced","profiles":[
                {"id":"balanced","label":"Balanced","default_megapixels":1,"megapixels":[1,2]},
                {"id":"fast","label":"Fast","default_megapixels":0.25,"megapixels":[0.25]}
            ]}
        }))
        .unwrap()
    }

    #[test]
    fn generation_capabilities_reject_unsupported_explicit_options() {
        let mut options = GenerationOptions {
            seed: Some(MAX_GENERATION_SEED),
            profile: Some("balanced".into()),
            megapixels: Some(2.),
        };
        validate_capabilities(&options, &capabilities()).unwrap();
        options.profile = Some("missing".into());
        assert!(
            validate_capabilities(&options, &capabilities())
                .unwrap_err()
                .to_string()
                .contains("does not advertise")
        );
        options.profile = Some("fast".into());
        assert!(
            validate_capabilities(&options, &capabilities())
                .unwrap_err()
                .to_string()
                .contains("does not support 2")
        );
        options.profile = None;
        validate_capabilities(&options, &capabilities()).unwrap();
        let mut missing_default = capabilities();
        missing_default.generation.default_profile = None;
        assert!(validate_capabilities(&options, &missing_default).is_err());
        let mut unsupported_seed = capabilities();
        unsupported_seed.generation.seed = false;
        assert!(validate_capabilities(&options, &unsupported_seed).is_err());
        let mut legacy = capabilities();
        legacy.protocol_version = 1;
        assert!(validate_capabilities(&options, &legacy).is_err());
    }

    #[test]
    fn generation_options_are_bounded_and_patch_round_trip_keeps_them() {
        for value in [
            serde_json::json!({"seed":0}),
            serde_json::json!({"seed":MAX_GENERATION_SEED+1}),
            serde_json::json!({"profile":"../model"}),
            serde_json::json!({"profile":" padded"}),
            serde_json::json!({"profile":""}),
            serde_json::json!({"profile":"x".repeat(65)}),
            serde_json::json!({"megapixels":0}),
            serde_json::json!({"megapixels":17}),
        ] {
            assert!(
                serde_json::from_value::<GenerationOptions>(value)
                    .unwrap()
                    .validate()
                    .is_err()
            );
        }
        assert!(
            GenerationOptions {
                megapixels: Some(f64::NAN),
                ..Default::default()
            }
            .validate()
            .is_err()
        );
        assert!(
            serde_json::from_value::<GenerationOptions>(serde_json::json!({"workflow":"anything"}))
                .is_err()
        );
        let mut value = serde_json::json!({"id":"patch","name":"edit","visible":true,"invert":false,"prompt":"remove","subMasks":[]});
        let old: crate::mask_generation::AiPatchDefinition =
            serde_json::from_value(value.clone()).unwrap();
        assert!(old.generation_options.is_none());
        assert!(
            serde_json::to_value(old)
                .unwrap()
                .get("generationOptions")
                .is_none()
        );
        value["generationOptions"] =
            serde_json::json!({"seed":104729,"profile":"balanced","megapixels":2.0});
        let patch: crate::mask_generation::AiPatchDefinition =
            serde_json::from_value(value.clone()).unwrap();
        let round_trip = serde_json::to_value(patch).unwrap();
        assert_eq!(round_trip["generationOptions"], value["generationOptions"]);
    }

    async fn read_request(stream: &mut tokio::net::TcpStream) -> (String, Vec<u8>) {
        let mut bytes = Vec::new();
        loop {
            let mut buffer = [0; 4096];
            let n = stream.read(&mut buffer).await.unwrap();
            assert!(n > 0);
            bytes.extend_from_slice(&buffer[..n]);
            if let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                let header = String::from_utf8(bytes[..end].to_vec()).unwrap();
                let length = header
                    .lines()
                    .find_map(|line| {
                        line.to_ascii_lowercase()
                            .strip_prefix("content-length:")
                            .map(|v| v.trim().parse::<usize>().unwrap())
                    })
                    .unwrap_or(0);
                while bytes.len() < end + 4 + length {
                    let n = stream.read(&mut buffer).await.unwrap();
                    assert!(n > 0);
                    bytes.extend_from_slice(&buffer[..n]);
                }
                return (header, bytes[end + 4..end + 4 + length].to_vec());
            }
        }
    }

    async fn reply(stream: &mut tokio::net::TcpStream, status: u16, body: &str) {
        let headers = format!(
            "HTTP/1.1 {status} Test\r\nContent-Length: {}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n",
            body.len()
        );
        stream.write_all(headers.as_bytes()).await.unwrap();
        stream.write_all(body.as_bytes()).await.unwrap();
    }

    #[tokio::test]
    async fn generation_options_are_forwarded_only_after_capability_acceptance() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let image = DynamicImage::ImageRgb8(RgbImage::from_pixel(16, 12, Rgb([20, 40, 60])));
        let color = image_to_base64(&image).unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            assert!(
                read_request(&mut stream)
                    .await
                    .0
                    .starts_with("GET /capabilities ")
            );
            reply(&mut stream,200,r#"{"protocol_version":2,"generation":{"seed":true,"default_profile":"balanced","profiles":[{"id":"balanced","label":"Balanced","default_megapixels":1,"megapixels":[1,2]}]}}"#).await;
            drop(stream);
            let (mut stream, _) = listener.accept().await.unwrap();
            let (header, body) = read_request(&mut stream).await;
            assert!(header.starts_with("POST /inpaint "));
            let payload: serde_json::Value = serde_json::from_slice(&body).unwrap();
            assert_eq!(payload["seed"], MAX_GENERATION_SEED);
            assert_eq!(payload["profile"], "balanced");
            assert_eq!(payload["megapixels"], 2.);
            reply(
                &mut stream,
                200,
                &serde_json::json!({"x":0,"y":0,"color":color}).to_string(),
            )
            .await;
        });
        let options = GenerationOptions {
            seed: Some(MAX_GENERATION_SEED),
            profile: Some("balanced".into()),
            megapixels: Some(2.),
        };
        let result = tokio::time::timeout(
            Duration::from_secs(5),
            process_inpainting(
                &url,
                "same.cr3",
                &image,
                &image,
                "remove".into(),
                None,
                Some(&options),
            ),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(result.image.dimensions(), (16, 12));
        server.await.unwrap();
    }

    #[tokio::test]
    async fn legacy_connector_rejects_options_before_sending_image_data() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let (header, body) = read_request(&mut stream).await;
            assert!(header.starts_with("GET /capabilities "));
            assert!(body.is_empty());
            reply(&mut stream, 404, "{}").await;
            drop(stream);
            assert!(
                tokio::time::timeout(Duration::from_millis(100), listener.accept())
                    .await
                    .is_err()
            );
        });
        let image = DynamicImage::ImageRgb8(RgbImage::from_pixel(16, 12, Rgb([20, 40, 60])));
        let options = GenerationOptions {
            seed: Some(104729),
            ..Default::default()
        };
        let error = process_inpainting(
            &url,
            "same.cr3",
            &image,
            &image,
            "remove".into(),
            None,
            Some(&options),
        )
        .await
        .unwrap_err();
        assert!(
            error
                .to_string()
                .contains("/capabilities returned HTTP 404")
        );
        server.await.unwrap();
    }
    use image::{DynamicImage, Rgb, RgbImage};
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };

    #[test]
    fn source_cache_keys_follow_uploaded_content_and_dimensions() {
        let before = DynamicImage::ImageRgb8(RgbImage::from_pixel(16, 12, Rgb([20, 40, 60])));
        let after = DynamicImage::ImageRgb8(RgbImage::from_pixel(16, 12, Rgb([180, 140, 100])));
        let before_bytes = image_to_jpeg_bytes(&before, 95).unwrap();
        let after_bytes = image_to_jpeg_bytes(&after, 95).unwrap();
        let first = generate_source_id(&before_bytes, (16, 12));
        assert_eq!(first, generate_source_id(&before_bytes, (16, 12)));
        assert_ne!(first, generate_source_id(&after_bytes, (16, 12)));
        assert_ne!(first, generate_source_id(&before_bytes, (12, 16)));
    }

    #[tokio::test]
    async fn sequential_edits_upload_changed_source_and_reuse_identical_content() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base_url = format!("http://{}", listener.local_addr().unwrap());
        let before = DynamicImage::ImageRgb8(RgbImage::from_pixel(16, 12, Rgb([20, 40, 60])));
        let after = DynamicImage::ImageRgb8(RgbImage::from_pixel(16, 12, Rgb([180, 140, 100])));
        let expected_before = image_to_jpeg_bytes(&before, 95).unwrap();
        let expected_after = image_to_jpeg_bytes(&after, 95).unwrap();
        let uploads = Arc::new(Mutex::new(Vec::new()));
        let observed_uploads = uploads.clone();
        let color = image_to_base64(&before).unwrap();
        let (stop, mut stopped) = tokio::sync::oneshot::channel::<()>();
        let server = tokio::spawn(async move {
            let mut cache: HashMap<String, Vec<u8>> = HashMap::new();
            loop {
                let accepted = tokio::select! {
                    accepted = listener.accept() => accepted,
                    _ = &mut stopped => break,
                };
                let (mut stream, _) = accepted.unwrap();
                let mut request = Vec::new();
                let (header_end, content_length) = loop {
                    let mut chunk = [0; 4096];
                    let n = stream.read(&mut chunk).await.unwrap();
                    assert!(n > 0);
                    request.extend_from_slice(&chunk[..n]);
                    if let Some(end) = request.windows(4).position(|w| w == b"\r\n\r\n") {
                        let header = String::from_utf8_lossy(&request[..end]);
                        let length = header
                            .lines()
                            .find_map(|line| {
                                line.to_ascii_lowercase()
                                    .strip_prefix("content-length:")
                                    .map(|v| v.trim().parse::<usize>().unwrap())
                            })
                            .unwrap();
                        break (end + 4, length);
                    }
                };
                while request.len() < header_end + content_length {
                    let mut chunk = [0; 4096];
                    let n = stream.read(&mut chunk).await.unwrap();
                    assert!(n > 0);
                    request.extend_from_slice(&chunk[..n]);
                }
                let body = &request[header_end..header_end + content_length];
                let (status, response) = if request.starts_with(b"POST /inpaint ") {
                    let payload: serde_json::Value = serde_json::from_slice(body).unwrap();
                    let id = payload["source_id"].as_str().unwrap();
                    if cache.contains_key(id) {
                        (
                            200,
                            serde_json::json!({"x":0,"y":0,"color":color}).to_string(),
                        )
                    } else {
                        (404, "{}".to_string())
                    }
                } else {
                    assert!(request.starts_with(b"POST /upload_source "));
                    let jpeg_start = body.windows(2).position(|w| w == [0xff, 0xd8]).unwrap();
                    let jpeg_end = body.windows(2).rposition(|w| w == [0xff, 0xd9]).unwrap() + 2;
                    let jpeg = body[jpeg_start..jpeg_end].to_vec();
                    let decoded = image::load_from_memory(&jpeg).unwrap();
                    let id = generate_source_id(&jpeg, (decoded.width(), decoded.height()));
                    assert!(body.windows(id.len()).any(|w| w == id.as_bytes()));
                    observed_uploads.lock().unwrap().push(jpeg.clone());
                    cache.insert(id, jpeg);
                    (200, "{}".to_string())
                };
                let headers = format!(
                    "HTTP/1.1 {status} Test\r\nContent-Length: {}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n",
                    response.len()
                );
                stream.write_all(headers.as_bytes()).await.unwrap();
                stream.write_all(response.as_bytes()).await.unwrap();
            }
        });
        for source in [&before, &after, &after] {
            let output = tokio::time::timeout(
                Duration::from_secs(5),
                process_inpainting(
                    &base_url,
                    "unchanged-photo.cr3",
                    source,
                    &before,
                    "remove object".into(),
                    None,
                    None,
                ),
            )
            .await
            .unwrap()
            .unwrap();
            assert_eq!(output.image.dimensions(), (16, 12));
        }
        stop.send(()).unwrap();
        server.await.unwrap();
        assert_eq!(
            *uploads.lock().unwrap(),
            vec![expected_before, expected_after]
        );
    }

    #[tokio::test]
    async fn health_requires_a_successful_connected_connector_response() {
        let connected = r#"{"status":"ok","connected":true,"comfy_url":"127.0.0.1:8188"}"#;
        for (status, body, expected) in [
            (200, connected, true),
            (204, "", false),
            (404, connected, false),
            (500, connected, false),
            (200, r#"{"status":"error","connected":false}"#, false),
            (200, r#"{"status":"error","connected":true}"#, false),
            (200, r#"{"status":"ok"}"#, false),
            (200, "<html>ComfyUI</html>", false),
        ] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap().to_string();
            let server = tokio::spawn(async move {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut request = [0; 4096];
                let length = stream.read(&mut request).await.unwrap();
                assert!(request[..length].starts_with(b"GET /health HTTP/1.1\r\n"));
                let response = format!(
                    "HTTP/1.1 {status} Test\r\nContent-Length: {}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                stream.write_all(response.as_bytes()).await.unwrap();
            });
            assert_eq!(
                check_status(&address).await.unwrap(),
                expected,
                "HTTP {status}: {body}"
            );
            server.await.unwrap();
        }
    }

    #[tokio::test]
    async fn unreachable_connector_is_disconnected() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap().to_string();
        drop(listener);
        assert!(!check_status(&address).await.unwrap());
    }

    #[tokio::test]
    async fn stalled_health_body_is_bounded() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap().to_string();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = [0; 4096];
            assert!(stream.read(&mut request).await.unwrap() > 0);
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n")
                .await
                .unwrap();
            std::future::pending::<()>().await;
            drop(stream);
        });
        let result = tokio::time::timeout(Duration::from_secs(7), check_status(&address)).await;
        server.abort();
        assert!(!result.expect("Health check must time out").unwrap());
    }
}
