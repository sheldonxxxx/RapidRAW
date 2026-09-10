// Export-only helper: bilinear sampling for float32 RAW input without requiring
// the optional FLOAT32_FILTERABLE GPU feature. The UI retains hardware sampling.
fn sample_input_bilinear(uv: vec2<f32>) -> vec4<f32> {
    let dimensions = vec2<i32>(textureDimensions(input_texture));
    let position = clamp(uv, vec2(0.0), vec2(1.0)) * vec2<f32>(dimensions) - 0.5;
    let base = vec2<i32>(floor(position));
    let fraction = fract(position);
    let limit = dimensions - 1;
    let a = textureLoad(input_texture, clamp(base, vec2(0), limit), 0);
    let b = textureLoad(input_texture, clamp(base + vec2(1, 0), vec2(0), limit), 0);
    let c = textureLoad(input_texture, clamp(base + vec2(0, 1), vec2(0), limit), 0);
    let d = textureLoad(input_texture, clamp(base + vec2(1, 1), vec2(0), limit), 0);
    return mix(mix(a, b, fraction.x), mix(c, d, fraction.x), fraction.y);
}
