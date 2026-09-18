//! Agent-facing recipe contract. Keep native names and units identical to
//! `src/utils/adjustments.ts`; reject values the permissive renderer would ignore.
//! No Tauri state or filesystem writes are needed to validate a recipe.

use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde_json::{Map, Value, json};
use std::{collections::HashSet, io::Cursor};

const CHANNELS: [&str; 4] = ["luma", "red", "green", "blue"];
const COLORS: [&str; 8] = [
    "reds", "oranges", "yellows", "greens", "aquas", "blues", "purples", "magentas",
];
const MAX_ASSET_BYTES: usize = 64 * 1024 * 1024;
const MAX_ASSET_PIXELS: u64 = 100_000_000;

fn number(min: f64, max: f64) -> Value {
    json!({"type":"number","minimum":min,"maximum":max})
}

fn integer(min: u64, max: u64) -> Value {
    json!({"type":"integer","minimum":min,"maximum":max})
}

fn boolean() -> Value {
    json!({"type":"boolean"})
}

fn string() -> Value {
    json!({"type":"string","maxLength":16384})
}

fn identifier() -> Value {
    json!({"type":"string","minLength":1,"maxLength":256})
}

fn enumeration(values: &[&str]) -> Value {
    json!({"type":"string","enum":values})
}

fn nullable(schema: Value) -> Value {
    json!({"anyOf":[schema,{"type":"null"}]})
}

fn object(properties: Value, required: &[&str]) -> Value {
    json!({"type":"object","properties":properties,"required":required,"additionalProperties":false})
}

fn array(items: Value, min: usize, max: usize) -> Value {
    json!({"type":"array","items":items,"minItems":min,"maxItems":max})
}

fn fields(names: &str, schema: Value) -> Map<String, Value> {
    names
        .split_whitespace()
        .map(|name| (name.to_string(), schema.clone()))
        .collect()
}

fn point(max: f64) -> Value {
    object(
        json!({"x":number(0.0,max),"y":number(0.0,max)}),
        &["x", "y"],
    )
}

fn curves_schema() -> Value {
    object(
        Value::Object(fields("luma red green blue", array(point(255.0), 2, 16))),
        &[],
    )
}

fn parametric_schema() -> Value {
    let mut props = fields("darks shadows highlights lights", number(-100.0, 100.0));
    props.insert("whiteLevel".into(), number(-100.0, 0.0));
    props.insert("blackLevel".into(), number(0.0, 100.0));
    props.extend(fields("split1 split2 split3", number(1.0, 99.0)));
    object(
        Value::Object(fields(
            "luma red green blue",
            object(Value::Object(props), &[]),
        )),
        &[],
    )
}

fn color_grading_schema() -> Value {
    let wheel = object(
        json!({
            "hue":number(0.0,360.0),"saturation":number(0.0,100.0),"luminance":number(-100.0,100.0)
        }),
        &[],
    );
    let mut props = fields("shadows midtones highlights global", wheel);
    props.insert("blending".into(), number(0.0, 100.0));
    props.insert("balance".into(), number(-100.0, 100.0));
    object(Value::Object(props), &[])
}

fn image_asset() -> Value {
    json!({
        "type":"string","minLength":1,"maxLength":MAX_ASSET_BYTES * 4 / 3 + 256,
        "description":"Base64 encoded PNG/JPEG image, optionally prefixed with data:image/...;base64,. Decoded image must be valid, at most 64 MiB encoded and 100 megapixels."
    })
}

fn adjustment_properties(local: bool) -> Map<String, Value> {
    let mut props = fields(
        "contrast highlights shadows whites blacks saturation temperature tint vibrance sharpness clarity dehaze structure",
        number(-100.0, 100.0),
    );
    props.extend(fields("exposure brightness", number(-5.0, 5.0)));
    props.insert("hue".into(), number(-180.0, 180.0));
    props.insert("sharpnessThreshold".into(), number(0.0, 80.0));
    props.extend(fields(
        "lumaNoiseReduction colorNoiseReduction",
        number(if local { -100.0 } else { 0.0 }, 100.0),
    ));
    props.extend(fields(
        "glowAmount halationAmount flareAmount",
        number(0.0, 100.0),
    ));
    props.insert("curves".into(), curves_schema());
    props.insert("pointCurves".into(), curves_schema());
    props.insert("parametricCurve".into(), parametric_schema());
    props.insert("curveMode".into(), enumeration(&["point", "parametric"]));
    props.insert("colorGrading".into(), color_grading_schema());
    props.insert(
        "hsl".into(),
        object(
            Value::Object(
                COLORS
                    .into_iter()
                    .map(|name| {
                        (
                            name.into(),
                            object(
                                Value::Object(fields(
                                    "hue saturation luminance",
                                    number(-100.0, 100.0),
                                )),
                                &[],
                            ),
                        )
                    })
                    .collect(),
            ),
            &[],
        ),
    );
    props.insert(
        "sectionVisibility".into(),
        object(
            Value::Object(fields("basic curves color details effects", boolean())),
            &[],
        ),
    );
    if local {
        props.insert("id".into(), identifier());
        return props;
    }
    props.extend(fields("centré chromaticAberrationBlueYellow chromaticAberrationRedCyan vignetteAmount vignetteRoundness transformDistortion transformVertical transformHorizontal transformAspect transformXOffset transformYOffset", number(-100.0,100.0)));
    props.extend(fields("grainAmount grainRoughness grainSize vignetteFeather vignetteMidpoint lutIntensity lensBlurAmount lensBlurDiffusion lensBlurMinDepth lensBlurMaxDepth lensBlurMinFade lensBlurMaxFade", number(0.0,100.0)));
    props.extend(fields(
        "lensDistortionAmount lensVignetteAmount lensTcaAmount",
        number(0.0, 200.0),
    ));
    props.extend(fields("flipHorizontal flipVertical showClipping lensBlurEnabled lensDistortionEnabled lensTcaEnabled lensVignetteEnabled lutIsSceneReferred", boolean()));
    props.extend(fields("rotation transformRotate", number(-45.0, 45.0)));
    props.insert("transformScale".into(), number(50.0, 150.0));
    props.insert("orientationSteps".into(), integer(0, 3));
    props.insert("toneMapper".into(), enumeration(&["basic", "agx"]));
    props.insert("aspectRatio".into(), nullable(number(0.001, 1000.0)));
    let mut crop = object(
        json!({"unit":enumeration(&["px"]),"x":number(0.0,100000.0),"y":number(0.0,100000.0),"width":number(1.0,100000.0),"height":number(1.0,100000.0)}),
        &["x", "y", "width", "height"],
    );
    crop["description"] = json!(
        "Full-resolution pixels after orientation, flips and rotation; crop must remain within the transformed image. Percent crops are unsupported by the native engine."
    );
    props.insert("crop".into(), nullable(crop));
    props.insert(
        "colorCalibration".into(),
        object(
            Value::Object(fields(
                "shadowsTint redHue redSaturation greenHue greenSaturation blueHue blueSaturation",
                number(-100.0, 100.0),
            )),
            &[],
        ),
    );
    props.insert(
        "lensCorrectionMode".into(),
        enumeration(&["auto", "manual"]),
    );
    props.extend(fields(
        "lensMaker lensModel lutPath lutName lutData",
        nullable(string()),
    ));
    props.insert("lutSize".into(), integer(0, 256));
    props.insert(
        "lensBlurShape".into(),
        enumeration(&["circle", "hexagon", "octagon", "ring"]),
    );
    props.insert("lensBlurDepthMap".into(), nullable(image_asset()));
    let mut lens = fields("k1 k2 k3 vig_k1 vig_k2 vig_k3", number(-100.0, 100.0));
    lens.extend(fields("tca_vr tca_vb", number(0.001, 100.0)));
    lens.insert("model".into(), integer(0, 3));
    props.insert(
        "lensDistortionParams".into(),
        nullable(object(Value::Object(lens), &[])),
    );
    props.insert("guidedPerspective".into(), object(json!({
        "enabled":boolean(),"autoCrop":boolean(),"lines":array(object(json!({"id":identifier(),"type":enumeration(&["vertical","horizontal"]),"p1":point(1.0),"p2":point(1.0)}), &["id","type","p1","p2"]),0,4)
    }), &[]));
    props.insert("masks".into(), array(mask_schema(false), 0, 32));
    props.insert("aiPatches".into(), array(mask_schema(true), 0, 128));
    props
}

fn submask_parameter_schema(kind: &str) -> Value {
    let mut props = Map::new();
    let mut required = Vec::new();
    match kind {
        "radial" => {
            props.extend(fields("centerX centerY", number(0.0, 100000.0)));
            props.extend(fields("radiusX radiusY", number(0.001, 100000.0)));
            props.insert("rotation".into(), number(-360.0, 360.0));
            props.insert("feather".into(), number(0.0, 1.0));
            required.extend([
                "centerX", "centerY", "radiusX", "radiusY", "rotation", "feather",
            ]);
        }
        "linear" => {
            props.extend(fields(
                "startX startY endX endY",
                number(-100000.0, 100000.0),
            ));
            let mut range = number(0.0, 100000.0);
            range["description"] = json!(
                "Half-width of the fade in source pixels, perpendicular to the boundary line; not a percentage."
            );
            props.insert("range".into(), range);
            props.extend(fields("fadeBefore fadeAfter", number(0.0, 100000.0)));
            props.insert(
                "falloff".into(),
                enumeration(&["linear", "smoothstep", "smootherstep"]),
            );
            props.get_mut("fadeBefore").unwrap()["description"] = json!(
                "Source-pixel distance from the boundary to zero coverage on the positive perpendicular side (below a left-to-right horizontal line). Defaults to range."
            );
            props.get_mut("fadeAfter").unwrap()["description"] = json!(
                "Source-pixel distance from the boundary to full coverage on the negative perpendicular side (above a left-to-right horizontal line). Defaults to range."
            );
            required.extend(["startX", "startY", "endX", "endY"]);
        }
        "brush" | "flow" | "clone" | "heal" | "liquify" | "retouch" => {
            let mut line = fields("brushSize", number(0.001, 100000.0));
            line.insert("tool".into(), enumeration(&["brush", "eraser"]));
            line.insert("feather".into(), number(0.0, 1.0));
            line.insert("points".into(), array(point(100000.0), 1, 100000));
            if kind == "flow" {
                line.insert("flow".into(), number(0.0, 100.0));
            }
            props.insert(
                "lines".into(),
                array(
                    object(Value::Object(line), &["tool", "brushSize", "points"]),
                    1,
                    10000,
                ),
            );
            props.insert("feather".into(), number(0.0, 1.0));
            if matches!(kind, "clone" | "heal") {
                props.extend(fields("sourceX sourceY", number(0.0, 100000.0)));
            }
            if kind == "heal" {
                props.insert("textureOnly".into(), boolean());
                props.insert("textureRadius".into(), number(1.0, 32.0));
                props.insert("textureTileSize".into(), json!({"type":"integer","minimum":64,"maximum":2048,"description":"Optional square donor area centred at source_point. Repeat reflected fine detail only, without repeating donor colour. Inspect for repeated structures; omit for full-footprint sampling."}));
                props.get_mut("textureOnly").unwrap()["description"] = json!(
                    "A visible heal submask enables texture transfer for the whole combined patch, retaining destination broad colour and light. Use only on a clean repair; default false."
                );
                props.get_mut("textureRadius").unwrap()["description"] = json!(
                    "Gaussian separation scale (sigma) in source pixels for textureOnly healing; default 8. All visible texture-only submasks must agree."
                );
            }
            if kind == "liquify" {
                props.insert("pressure".into(), number(1.0, 100.0));
                props.insert(
                    "liquifyMode".into(),
                    enumeration(&["push", "pinch", "expand", "twirl"]),
                );
            }
            if kind == "retouch" {
                props.insert("intensity".into(), number(1.0, 100.0));
            }
            required.push("lines");
        }
        "color" | "luminance" => {
            props.extend(fields("targetX targetY", number(0.0, 100000.0)));
            props.insert("tolerance".into(), number(1.0, 100.0));
            required.extend(["targetX", "targetY"]);
        }
        "ai-subject" | "quick-eraser" => {
            props.extend(fields("startX startY endX endY", number(0.0, 100000.0)));
            required.extend(["startX", "startY", "endX", "endY"]);
        }
        "ai-normals" | "ai-albedo" => {
            let kind_name = if kind == "ai-normals" {
                "normals"
            } else {
                "albedo"
            };
            props.insert(
                "surfaceArtifact".into(),
                object(
                    json!({
                        "version":{"type":"integer","const":1}, "kind":{"const":kind_name},
                        "profile":{"const":format!("marigold-v2-{kind_name}-q4-v1")},
                        "sourceWidth":integer(1,100000),"sourceHeight":integer(1,100000),
                        "sourceHash":{"type":"string","pattern":"^[a-f0-9]{64}$","maxLength":64},
                        "geometryHash":{"type":"string","pattern":"^[a-f0-9]{64}$","maxLength":64},
                        "workflowHash":{"type":"string","pattern":"^[a-f0-9]{64}$","maxLength":64},
                        "mapHash":{"type":"string","pattern":"^[a-f0-9]{64}$","maxLength":64}
                    }),
                    &[
                        "version",
                        "kind",
                        "profile",
                        "sourceWidth",
                        "sourceHeight",
                        "sourceHash",
                        "geometryHash",
                        "workflowHash",
                        "mapHash",
                    ],
                ),
            );
            required.push("surfaceArtifact");
            if kind == "ai-normals" {
                props.insert("normalAngle".into(), number(-360.0, 360.0));
                props.insert("normalAmount".into(), number(-1.5, 1.5));
            } else {
                props.extend(fields(
                    "surfacePointX surfacePointY surfaceAmount",
                    number(0.0, 1.0),
                ));
                props.insert("surfaceTolerance".into(), number(0.005, 1.0));
                props.insert("surfaceColor".into(), array(integer(0, 255), 3, 3));
            }
        }
        "ai-depth" => {
            props.insert(
                "depthProvider".into(),
                json!({"enum":["builtin","marigold"]}),
            );
            props.insert(
                "depthArtifact".into(),
                object(
                    json!({
                        "version":{"type":"integer","const":1},
                        "profile":{"type":"string","const":"marigold-v2-q4-v1"},
                        "sourceWidth":integer(1,100000), "sourceHeight":integer(1,100000),
                        "sourceHash":{"type":"string","pattern":"^[a-f0-9]{64}$","maxLength":64},
                        "geometryHash":{"type":"string","pattern":"^[a-f0-9]{64}$","maxLength":64},
                        "workflowHash":{"type":"string","pattern":"^[a-f0-9]{64}$","maxLength":64},
                        "mapHash":{"type":"string","pattern":"^[a-f0-9]{64}$","maxLength":64}
                    }),
                    &[
                        "version",
                        "profile",
                        "sourceWidth",
                        "sourceHeight",
                        "sourceHash",
                        "geometryHash",
                        "workflowHash",
                        "mapHash",
                    ],
                ),
            );
            props.extend(fields(
                "minDepth maxDepth minFade maxFade",
                number(0.0, 100.0),
            ));
            required.extend(["minDepth", "maxDepth", "minFade", "maxFade"]);
        }
        "ai-foreground" | "ai-sky" | "all" => {}
        _ => unreachable!("only the supported kinds construct schemas"),
    }
    if kind == "ai-subject" {
        props.insert(
            "samRefinement".into(),
            object(
                json!({
                    "version":{"type":"integer","const":1},
                    "encoding":{"type":"string","const":"f32-le-base64"},
                    "logitsBase64":{"type":"string","minLength":349528,"maxLength":349528},
                    "sourceSha256":{"type":"string","minLength":64,"maxLength":64,"pattern":"^[a-f0-9]{64}$"},
                    "geometrySha256":{"type":"string","minLength":64,"maxLength":64,"pattern":"^[a-f0-9]{64}$"},
                    "maskSha256":{"type":"string","minLength":64,"maxLength":64,"pattern":"^[a-f0-9]{64}$"},
                    "canvasWidth":integer(1,100000),"canvasHeight":integer(1,100000),
                    "includePoints":array(point(100000.0),0,64),"excludePoints":array(point(100000.0),0,64),
                    "region":nullable(object(json!({"x":number(0.0,100000.0),"y":number(0.0,100000.0),"width":number(0.001,100000.0),"height":number(0.001,100000.0)}), &["x","y","width","height"]))
                }),
                &[
                    "version",
                    "encoding",
                    "logitsBase64",
                    "sourceSha256",
                    "geometrySha256",
                    "maskSha256",
                    "canvasWidth",
                    "canvasHeight",
                ],
            ),
        );
    }
    if kind.starts_with("ai-") || kind == "quick-eraser" {
        props.insert("maskDataBase64".into(), image_asset());
        required.push("maskDataBase64");
    }
    if kind.starts_with("ai-") || matches!(kind, "quick-eraser" | "color" | "luminance") {
        props.insert("rotation".into(), number(-45.0, 45.0));
        props.extend(fields("flipHorizontal flipVertical", boolean()));
        props.insert("orientationSteps".into(), integer(0, 3));
        props.insert("grow".into(), number(-100.0, 100.0));
        props.insert("feather".into(), number(0.0, 100.0));
    }
    object(Value::Object(props), &required)
}

fn submask_schema() -> Value {
    let kinds = [
        "radial",
        "linear",
        "brush",
        "flow",
        "color",
        "luminance",
        "ai-subject",
        "ai-foreground",
        "ai-sky",
        "ai-depth",
        "ai-normals",
        "ai-albedo",
        "quick-eraser",
        "all",
        "clone",
        "heal",
        "liquify",
        "retouch",
    ];
    let variants: Vec<Value> = kinds.into_iter().map(|kind| {
        object(json!({"id":identifier(),"name":string(),"type":{"const":kind},"visible":boolean(),"invert":boolean(),"opacity":number(0.0,100.0),"mode":enumeration(&["additive","subtractive","intersect"]),"parameters":submask_parameter_schema(kind)}), &["id","type","visible","mode","parameters"])
    }).collect();
    json!({"oneOf":variants,"description":"Coordinates are full-resolution pixels in the uncropped oriented image. Bitmap masks must embed their image data. Opacity defaults to 100; invert defaults to false."})
}

fn mask_schema(patch: bool) -> Value {
    let mut props = fields("id", identifier());
    props.insert("name".into(), string());
    props.extend(fields("visible invert", boolean()));
    props.insert("opacity".into(), number(0.0, 100.0));
    props.insert("subMasks".into(), array(submask_schema(), 1, 128));
    let mut required = vec!["id", "name", "visible", "invert", "subMasks"];
    if patch {
        props.insert("prompt".into(), string());
        props.insert("generationOptions".into(), object(json!({
            "seed":integer(1,crate::ai_connector::MAX_GENERATION_SEED),
            "profile":{"type":"string","minLength":1,"maxLength":64,"pattern":"^[A-Za-z0-9][A-Za-z0-9_.-]*$"},
            "megapixels":number(0.0625,16.0)
        }), &[]));
        props.insert("isLoading".into(), json!({"const":false}));
        props.insert("patchData".into(),object(json!({
            "color":image_asset(),"mask":image_asset(),"offsetX":integer(0,100000),"offsetY":integer(0,100000),"width":integer(1,100000),"height":integer(1,100000),"isSrgbEncoded":boolean(),
            "generation":object(json!({
                "seed":integer(1,crate::ai_connector::MAX_GENERATION_SEED),
                "profile":{"type":"string","minLength":1,"maxLength":64,"pattern":"^[A-Za-z0-9][A-Za-z0-9_.-]*$"},
                "sourceSize":array(integer(1,100000),2,2),"generatedSize":array(integer(1,100000),2,2),
                "context":object(json!({"x":integer(0,100000),"y":integer(0,100000),"width":integer(1,100000),"height":integer(1,100000)}), &["x","y","width","height"]),
                "seconds":number(0.0,86400.0),"processing":enumeration(&["native_tiles"]),"tileSize":integer(64,4096)
            }), &["seed","profile","sourceSize","generatedSize","context","seconds"])
        }), &["color","mask","offsetX","offsetY","width","height","isSrgbEncoded"]));
        required.extend(["prompt", "patchData"]);
    } else {
        props.insert(
            "adjustments".into(),
            object(Value::Object(adjustment_properties(true)), &[]),
        );
        required.push("adjustments");
    }
    object(Value::Object(props), &required)
}

/// JSON Schema for every editable native recipe field. Runtime validation also
/// checks cross-field geometry, image decoding and curve point ordering.
pub fn adjustment_schema() -> Value {
    let mut schema = object(Value::Object(adjustment_properties(false)), &[]);
    schema["$schema"] = json!("https://json-schema.org/draft/2020-12/schema");
    schema["title"] = json!("RapidRAW adjustments");
    schema["description"] = json!(
        "Native RapidRAW names and UI slider units. Omitted fields use engine defaults. Edit only known keys. Curves use 0..255 coordinates and at most 16 points per channel. Crop and mask geometry use pixels, except guided perspective points which use 0..1 coordinates. pointCurves/parametricCurve are compiled to curves when changed through merge_patch. lutPath is authoritative; lutData/lutSize/lutName are UI metadata."
    );
    schema["default"] = default_adjustments();
    schema
}

/// Mirrors INITIAL_ADJUSTMENTS in src/utils/adjustments.ts, without importing TS
/// or depending on a frontend bundle at runtime.
pub fn default_adjustments() -> Value {
    let mut defaults = Map::new();
    for (name, schema) in adjustment_properties_without_recursive_defaults() {
        let value = match schema.get("type").and_then(Value::as_str) {
            Some("number" | "integer") => json!(0),
            Some("boolean") => json!(false),
            _ => Value::Null,
        };
        defaults.insert(name, value);
    }
    let mut value = Value::Object(defaults);
    for key in ["grainRoughness", "vignetteFeather", "vignetteMidpoint"] {
        value[key] = json!(50);
    }
    value["grainSize"] = json!(25);
    value["sharpnessThreshold"] = json!(15);
    for key in [
        "lutIntensity",
        "lensDistortionAmount",
        "lensVignetteAmount",
        "lensTcaAmount",
        "transformScale",
        "lensBlurMaxDepth",
    ] {
        value[key] = json!(100);
    }
    for key in [
        "lensDistortionEnabled",
        "lensTcaEnabled",
        "lensVignetteEnabled",
    ] {
        value[key] = json!(true);
    }
    value["lensBlurAmount"] = json!(40);
    for key in ["lensBlurMinDepth", "lensBlurMinFade", "lensBlurMaxFade"] {
        value[key] = json!(20);
    }
    value["lensBlurShape"] = json!("circle");
    value["lensCorrectionMode"] = json!("manual");
    value["toneMapper"] = json!("basic");
    value["curveMode"] = json!("point");
    value["guidedPerspective"] = json!({"enabled":false,"lines":[],"autoCrop":true});
    value["masks"] = json!([]);
    value["aiPatches"] = json!([]);
    value["sectionVisibility"] =
        json!({"basic":true,"curves":true,"color":true,"details":true,"effects":true});
    value["colorCalibration"] = Value::Object(fields(
        "shadowsTint redHue redSaturation greenHue greenSaturation blueHue blueSaturation",
        json!(0),
    ));
    value["hsl"] = Value::Object(
        COLORS
            .into_iter()
            .map(|c| (c.into(), json!({"hue":0,"saturation":0,"luminance":0})))
            .collect(),
    );
    value["colorGrading"] = json!({"balance":0,"blending":50,"global":{"hue":0,"saturation":0,"luminance":0},"shadows":{"hue":0,"saturation":0,"luminance":0},"midtones":{"hue":0,"saturation":0,"luminance":0},"highlights":{"hue":0,"saturation":0,"luminance":0}});
    value["curves"] = default_curves();
    value["pointCurves"] = default_curves();
    value["parametricCurve"] = Value::Object(
        CHANNELS
            .into_iter()
            .map(|c| (c.into(), parametric_defaults()))
            .collect(),
    );
    value
}

fn adjustment_properties_without_recursive_defaults() -> Map<String, Value> {
    // Schema builders never call default_adjustments, so this also keeps the
    // accepted top-level field set and defaults in exact correspondence.
    adjustment_properties(false)
}

fn default_curves() -> Value {
    Value::Object(
        CHANNELS
            .into_iter()
            .map(|c| (c.into(), json!([{"x":0,"y":0},{"x":255,"y":255}])))
            .collect(),
    )
}

fn parametric_defaults() -> Value {
    json!({"darks":0,"shadows":0,"highlights":0,"lights":0,"whiteLevel":0,"blackLevel":0,"split1":25,"split2":50,"split3":75})
}

// A small validator for exactly the JSON Schema vocabulary emitted above.
// Keeping the schema executable prevents documentation/validation divergence.
fn validate_schema(value: &Value, schema: &Value, path: &str) -> Result<(), String> {
    if let Some(expected) = schema.get("const")
        && value != expected
    {
        return Err(format!("{path}: expected {expected}"));
    }
    if let Some(choices) = schema.get("enum").and_then(Value::as_array)
        && !choices.contains(value)
    {
        return Err(format!("{path}: expected one of {}", json!(choices)));
    }
    for combinator in ["anyOf", "oneOf"] {
        if let Some(variants) = schema.get(combinator).and_then(Value::as_array) {
            let mut successes = 0;
            let mut relevant_error = None;
            for variant in variants {
                match validate_schema(value, variant, path) {
                    Ok(()) => successes += 1,
                    Err(error) => {
                        if variant.pointer("/properties/type/const") == value.get("type") {
                            relevant_error = Some(error);
                        }
                    }
                }
            }
            if successes == 0 || (combinator == "oneOf" && successes != 1) {
                return Err(relevant_error.unwrap_or_else(|| {
                    format!("{path}: value does not match an allowed type or mask definition")
                }));
            }
            return Ok(());
        }
    }
    match schema.get("type").and_then(Value::as_str) {
        Some("object") => {
            let map = value
                .as_object()
                .ok_or_else(|| format!("{path}: expected an object"))?;
            let props = schema["properties"]
                .as_object()
                .expect("object schema has properties");
            for required in schema["required"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
            {
                if !map.contains_key(required) {
                    return Err(format!("{path}.{required}: required field is missing"));
                }
            }
            for (key, item) in map {
                let child = props.get(key).ok_or_else(|| {
                    format!(
                        "{path}.{key}: unknown field (would be silently ignored by the renderer)"
                    )
                })?;
                validate_schema(item, child, &format!("{path}.{key}"))?;
            }
        }
        Some("array") => {
            let values = value
                .as_array()
                .ok_or_else(|| format!("{path}: expected an array"))?;
            let min = schema["minItems"].as_u64().unwrap_or(0) as usize;
            let max = schema["maxItems"].as_u64().unwrap_or(u64::MAX) as usize;
            if values.len() < min || values.len() > max {
                return Err(format!("{path}: requires {min}..{max} entries"));
            }
            for (index, item) in values.iter().enumerate() {
                validate_schema(item, &schema["items"], &format!("{path}[{index}]"))?;
            }
        }
        Some("number" | "integer") => {
            let number = value
                .as_f64()
                .filter(|n| n.is_finite())
                .ok_or_else(|| format!("{path}: expected a finite number"))?;
            if schema["type"] == "integer" && number.fract() != 0.0 {
                return Err(format!("{path}: expected an integer"));
            }
            let min = schema["minimum"].as_f64().unwrap_or(f64::NEG_INFINITY);
            let max = schema["maximum"].as_f64().unwrap_or(f64::INFINITY);
            if number < min || number > max {
                return Err(format!("{path}: {number} is outside {min}..{max}"));
            }
        }
        Some("string") => {
            let text = value
                .as_str()
                .ok_or_else(|| format!("{path}: expected a string"))?;
            let min = schema["minLength"].as_u64().unwrap_or(0) as usize;
            let max = schema["maxLength"].as_u64().unwrap_or(u64::MAX) as usize;
            if text.len() < min || text.len() > max {
                return Err(format!("{path}: string length is outside {min}..{max}"));
            }
        }
        Some("boolean") if !value.is_boolean() => {
            return Err(format!("{path}: expected a boolean"));
        }
        Some("null") if !value.is_null() => return Err(format!("{path}: expected null")),
        _ => {}
    }
    Ok(())
}

fn decode_asset(value: &Value, path: &str) -> Result<(u32, u32), String> {
    let text = value
        .as_str()
        .ok_or_else(|| format!("{path}: missing embedded bitmap"))?;
    let data = if text.starts_with("data:") {
        let (header, data) = text
            .split_once(',')
            .ok_or_else(|| format!("{path}: malformed image data URL"))?;
        if !header.starts_with("data:image/") || !header.ends_with(";base64") {
            return Err(format!("{path}: expected a base64 image data URL"));
        }
        data
    } else {
        text
    };
    if data.len() > MAX_ASSET_BYTES * 4 / 3 + 4 {
        return Err(format!("{path}: bitmap exceeds 64 MiB limit"));
    }
    let bytes = STANDARD
        .decode(data)
        .map_err(|_| format!("{path}: invalid base64 bitmap"))?;
    let reader = image::ImageReader::new(Cursor::new(&bytes))
        .with_guessed_format()
        .map_err(|e| format!("{path}: {e}"))?;
    let dimensions = reader
        .into_dimensions()
        .map_err(|e| format!("{path}: invalid bitmap: {e}"))?;
    if dimensions.0 == 0
        || dimensions.1 == 0
        || u64::from(dimensions.0) * u64::from(dimensions.1) > MAX_ASSET_PIXELS
    {
        return Err(format!(
            "{path}: bitmap dimensions exceed 100 megapixels or are empty"
        ));
    }
    // Checking headers alone misses truncated or corrupt image payloads.
    image::load_from_memory(&bytes).map_err(|e| format!("{path}: cannot decode bitmap: {e}"))?;
    Ok(dimensions)
}

fn validate_curves(value: &Value, path: &str) -> Result<(), String> {
    for key in ["curves", "pointCurves"] {
        for channel in CHANNELS {
            if let Some(points) = value[key][channel].as_array() {
                for pair in points.windows(2) {
                    if pair[0]["x"].as_f64() >= pair[1]["x"].as_f64() {
                        return Err(format!(
                            "{path}.{key}.{channel}: point x coordinates must strictly increase"
                        ));
                    }
                }
            }
        }
    }
    for channel in CHANNELS {
        if let Some(settings) = value["parametricCurve"].get(channel) {
            let s1 = settings["split1"].as_f64().unwrap_or(25.0);
            let s2 = settings["split2"].as_f64().unwrap_or(50.0);
            let s3 = settings["split3"].as_f64().unwrap_or(75.0);
            if !(s1 < s2 && s2 < s3) {
                return Err(format!(
                    "{path}.parametricCurve.{channel}: require split1 < split2 < split3"
                ));
            }
        }
    }
    Ok(())
}

fn validate_submask(value: &Value, path: &str, ids: &mut HashSet<String>) -> Result<(), String> {
    let id = value["id"].as_str().expect("schema checked id");
    if !ids.insert(id.to_string()) {
        return Err(format!(
            "{path}.id: duplicate id '{id}' risks the wrong cached bitmap"
        ));
    }
    let kind = value["type"].as_str().expect("schema checked mask type");
    let params = &value["parameters"];
    if kind.starts_with("ai-") || kind == "quick-eraser" {
        decode_asset(
            &params["maskDataBase64"],
            &format!("{path}.parameters.maskDataBase64"),
        )?;
    }
    if crate::marigold_surface::is_surface(kind) {
        let artifact = serde_json::from_value(params["surfaceArtifact"].clone())
            .map_err(|_| format!("{path}: missing surface artifact"))?;
        crate::marigold_surface::validate_artifact(
            params["maskDataBase64"].as_str().unwrap(),
            &artifact,
        )?;
    }
    if kind == "ai-depth" {
        if params["depthProvider"] == "marigold" {
            let artifact = serde_json::from_value(params["depthArtifact"].clone())
                .map_err(|_| format!("{path}: Marigold requires a depth artifact"))?;
            crate::marigold_depth::validate_artifact(
                params["maskDataBase64"].as_str().unwrap(),
                &artifact,
            )?;
        } else if params.get("depthArtifact").is_some() {
            return Err(format!(
                "{path}: depth artifact requires the Marigold provider"
            ));
        }
    }
    if let Some(state) = params.get("samRefinement") {
        for key in ["sourceSha256", "geometrySha256", "maskSha256"] {
            let hash = state[key].as_str().unwrap();
            if hash.len() != 64
                || !hash
                    .bytes()
                    .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
            {
                return Err(format!(
                    "{path}.parameters.samRefinement.{key}: require lowercase SHA-256"
                ));
            }
        }
        crate::ai_processing::sam_refinement::decode_logits(
            state["logitsBase64"].as_str().unwrap(),
        )
        .map_err(|e| format!("{path}.parameters.samRefinement: {e}"))?;
        let dimension = |key: &str| {
            state[key].as_u64().ok_or_else(|| {
                format!("{path}.parameters.samRefinement.{key}: require an unsigned JSON integer")
            })
        };
        let area = dimension("canvasWidth")? * dimension("canvasHeight")?;
        if area > MAX_ASSET_PIXELS {
            return Err(format!(
                "{path}.parameters.samRefinement: canvas exceeds pixel limit"
            ));
        }
    }
    if matches!(kind, "linear" | "ai-subject" | "quick-eraser") {
        let x1 = params["startX"].as_f64().unwrap_or(0.0);
        let x2 = params["endX"].as_f64().unwrap_or(0.0);
        let y1 = params["startY"].as_f64().unwrap_or(0.0);
        let y2 = params["endY"].as_f64().unwrap_or(0.0);
        if kind == "linear" && x1 == x2 && y1 == y2 {
            return Err(format!("{path}: linear gradient endpoints must differ"));
        }
        if kind != "linear" && (x2 <= x1 || y2 <= y1) {
            return Err(format!(
                "{path}: subject rectangle requires endX > startX and endY > startY"
            ));
        }
    }
    if kind == "ai-depth" && params["minDepth"].as_f64() > params["maxDepth"].as_f64() {
        return Err(format!("{path}: minDepth cannot exceed maxDepth"));
    }
    Ok(())
}

/// Validate a complete or sparse native recipe against the dimensions of the
/// pristine orientation-corrected source. Does not mutate the recipe or image.
pub fn validate_adjustments(value: &Value, dimensions: (u32, u32)) -> Result<(), String> {
    if dimensions.0 == 0 || dimensions.1 == 0 {
        return Err("source image dimensions must be nonzero".into());
    }
    validate_schema(
        value,
        &object(Value::Object(adjustment_properties(false)), &[]),
        "adjustments",
    )?;
    validate_curves(value, "adjustments")?;
    if let Some(crop) = value.get("crop").filter(|c| !c.is_null()) {
        // Rotation uses crop=false and preserves the coarse-rotated canvas size.
        let (width, height) = if value["orientationSteps"].as_u64().unwrap_or(0) % 2 == 1 {
            (dimensions.1, dimensions.0)
        } else {
            dimensions
        };
        let x = crop["x"].as_f64().unwrap();
        let y = crop["y"].as_f64().unwrap();
        let w = crop["width"].as_f64().unwrap();
        let h = crop["height"].as_f64().unwrap();
        if x + w > f64::from(width) + 0.001 || y + h > f64::from(height) + 0.001 {
            return Err(format!(
                "adjustments.crop: crop exceeds the {width}x{height} oriented canvas"
            ));
        }
    }
    if let Some(guides) = value["guidedPerspective"]["lines"].as_array() {
        let mut ids = HashSet::new();
        for line in guides {
            if !ids.insert(line["id"].as_str().unwrap()) {
                return Err("adjustments.guidedPerspective: duplicate line id".into());
            }
            if line["p1"] == line["p2"] {
                return Err("adjustments.guidedPerspective: guide endpoints must differ".into());
            }
        }
        for direction in ["vertical", "horizontal"] {
            if guides.iter().filter(|g| g["type"] == direction).count() > 2 {
                return Err(format!(
                    "adjustments.guidedPerspective: at most two {direction} lines are supported"
                ));
            }
        }
    }
    if value["lensBlurEnabled"] == true {
        let dims = decode_asset(&value["lensBlurDepthMap"], "adjustments.lensBlurDepthMap")?;
        if dims.0 < 2 || dims.1 < 2 {
            return Err("adjustments.lensBlurDepthMap: depth map must be at least 2x2".into());
        }
    } else if let Some(data) = value.get("lensBlurDepthMap").filter(|v| !v.is_null()) {
        decode_asset(data, "adjustments.lensBlurDepthMap")?;
    }
    if value["lensBlurMinDepth"].as_f64().unwrap_or(20.0)
        > value["lensBlurMaxDepth"].as_f64().unwrap_or(100.0)
    {
        return Err("adjustments: lensBlurMinDepth cannot exceed lensBlurMaxDepth".into());
    }
    // Embedded lutData is frontend cache metadata; only a parsed lutPath can
    // actually affect the renderer. Parsing is performed by the bridge itself.
    if value.get("lutData").is_some_and(|v| !v.is_null())
        && value["lutPath"].as_str().is_none_or(str::is_empty)
    {
        return Err(
            "adjustments.lutData: lutPath is required; embedded LUT metadata is not rendered"
                .into(),
        );
    }
    if let Some(path) = value["lutPath"].as_str()
        && path.trim().is_empty()
    {
        return Err("adjustments.lutPath: use null to remove a LUT, not an empty path".into());
    }
    let mut ids = HashSet::new();
    if let Some(masks) = value["masks"].as_array() {
        let slots: usize = masks
            .iter()
            .map(|m| {
                1 + usize::from(
                    m["subMasks"]
                        .as_array()
                        .is_some_and(|parts| parts.iter().any(|p| p["type"] == "ai-normals")),
                )
            })
            .sum();
        if slots > crate::image_processing::MAX_MASKS {
            return Err("adjustments.masks: maximum 32 render slots; each directional light mask uses two slots".into());
        }
    }
    for collection in ["masks", "aiPatches"] {
        if let Some(containers) = value[collection].as_array() {
            for (index, container) in containers.iter().enumerate() {
                let path = format!("adjustments.{collection}[{index}]");
                let id = container["id"].as_str().unwrap();
                if !ids.insert(id.to_string()) {
                    return Err(format!("{path}.id: duplicate id '{id}'"));
                }
                if collection == "masks" {
                    validate_curves(&container["adjustments"], &format!("{path}.adjustments"))?;
                }
                let submasks = container["subMasks"].as_array().unwrap();
                let surface_count = submasks
                    .iter()
                    .filter(|sm| {
                        crate::marigold_surface::is_surface(sm["type"].as_str().unwrap_or(""))
                    })
                    .count();
                if surface_count > 1 || (collection == "aiPatches" && surface_count > 0) {
                    return Err(format!(
                        "{path}: use one normals or albedo component per adjustment mask"
                    ));
                }
                if container["visible"] == true && !submasks.iter().any(|sm| sm["visible"] == true)
                {
                    return Err(format!("{path}: visible container has no visible submask"));
                }
                for (subindex, submask) in submasks.iter().enumerate() {
                    validate_submask(submask, &format!("{path}.subMasks[{subindex}]"), &mut ids)?;
                }
                if collection == "aiPatches" {
                    if let Some(value) = container.get("generationOptions") {
                        let options: crate::ai_connector::GenerationOptions =
                            serde_json::from_value(value.clone())
                                .map_err(|error| format!("{path}.generationOptions: {error}"))?;
                        options
                            .validate()
                            .map_err(|error| format!("{path}.generationOptions: {error}"))?;
                    }
                    let patch = &container["patchData"];
                    if let Some(value) = patch.get("generation") {
                        let receipt: crate::ai_connector::GenerationMetadata =
                            serde_json::from_value(value.clone())
                                .map_err(|error| format!("{path}.patchData.generation: {error}"))?;
                        receipt
                            .validate([dimensions.0, dimensions.1])
                            .map_err(|error| format!("{path}.patchData.generation: {error}"))?;
                    }
                    let color = decode_asset(&patch["color"], &format!("{path}.patchData.color"))?;
                    let mask = decode_asset(&patch["mask"], &format!("{path}.patchData.mask"))?;
                    let expected = (
                        patch["width"].as_u64().unwrap() as u32,
                        patch["height"].as_u64().unwrap() as u32,
                    );
                    if color != expected || mask != expected {
                        return Err(format!(
                            "{path}.patchData: color, mask, width and height must match"
                        ));
                    }
                    if patch["offsetX"].as_u64().unwrap() + u64::from(expected.0)
                        > u64::from(dimensions.0)
                        || patch["offsetY"].as_u64().unwrap() + u64::from(expected.1)
                            > u64::from(dimensions.1)
                    {
                        return Err(format!(
                            "{path}.patchData: patch exceeds the pristine source canvas"
                        ));
                    }
                }
            }
        }
    }
    Ok(())
}

fn rfc_merge(base: &mut Value, patch: &Value) {
    if let Some(map) = patch.as_object() {
        if !base.is_object() {
            *base = json!({});
        }
        let target = base.as_object_mut().unwrap();
        for (key, value) in map {
            if value.is_null() {
                target.remove(key);
            } else {
                rfc_merge(target.entry(key.clone()).or_insert(Value::Null), value);
            }
        }
    } else {
        *base = patch.clone();
    }
}

/// Apply RFC 7396 JSON Merge Patch: objects merge recursively, arrays replace,
/// null deletes a key. The root must stay an object. Unknown top-level fields
/// fail atomically. Curve UI changes also rebuild the native `curves` payload.
/// Call validate_adjustments on a candidate before committing session state.
pub fn merge_patch(base: &mut Value, patch: &Value) -> Result<(), String> {
    let map = patch
        .as_object()
        .ok_or("adjustment patch must be an object")?;
    let allowed = adjustment_properties(false);
    for key in map.keys() {
        if !allowed.contains_key(key) {
            return Err(format!("adjustments.{key}: unknown adjustment"));
        }
    }
    if !base.is_object() {
        return Err("base adjustments must be an object".into());
    }
    let mut candidate = base.clone();
    rfc_merge(&mut candidate, patch);
    // Native `curves` is authoritative in saved frontend recipes: pointCurves
    // intentionally stores the last point-mode curve while parametric editing.
    // Only compile UI controls when no explicit rendered curve was supplied.
    resolve_curve_patch(&mut candidate, patch);
    if let Some(masks) = candidate["masks"].as_array_mut() {
        // Array replacement carries complete native/UI local recipes.
        if map.contains_key("masks") {
            for mask in masks {
                let local = &mut mask["adjustments"];
                let local_patch = local.clone();
                resolve_curve_patch(local, &local_patch);
            }
        }
    }
    *base = candidate;
    Ok(())
}

/// Recompile only newly supplied UI curve controls. An explicit native curve
/// in the same patch is authoritative, including in older saved recipes.
pub fn resolve_curve_patch(value: &mut Value, patch: &Value) {
    if patch.get("curves").is_none()
        && ["pointCurves", "parametricCurve", "curveMode"]
            .iter()
            .any(|key| patch.get(*key).is_some())
    {
        resolve_curves(value);
    }
}

/// Materialize frontend point/parametric curve controls into the engine's
/// `curves` field. Formula mirrors buildParametricPoints in Curves.tsx.
pub fn resolve_curves(value: &mut Value) {
    if !value.is_object() {
        return;
    }
    let mut curves = value
        .get("curves")
        .cloned()
        .filter(Value::is_object)
        .unwrap_or_else(default_curves);
    if value["curveMode"] == "parametric" {
        for channel in CHANNELS {
            let mut settings = parametric_defaults();
            if let Some(patch) = value["parametricCurve"].get(channel) {
                rfc_merge(&mut settings, patch);
            }
            let n = |key: &str| settings[key].as_f64().unwrap_or(0.0);
            let s1 = n("split1") / 100.0;
            let s2 = n("split2") / 100.0;
            let s3 = n("split3") / 100.0;
            let xs = [0.0, s1 / 2.0, s1, s2, s3, (s3 + 1.0) / 2.0, 1.0];
            let response = |key: &str, x: f64| {
                let v = n(key) / 100.0;
                let headroom = if v >= 0.0 { 1.0 - x } else { x };
                (v * 1.2).tanh() * 0.35 * headroom.max(0.0).sqrt()
            };
            let ys = [
                0.0,
                xs[1] + response("shadows", xs[1]),
                s1 + (response("shadows", s1) + response("darks", s1)) / 2.0,
                s2 + (response("darks", s2) + response("lights", s2)) / 2.0,
                s3 + (response("lights", s3) + response("highlights", s3)) / 2.0,
                xs[5] + response("highlights", xs[5]),
                1.0,
            ];
            let mut points: Vec<Value> = xs
                .iter()
                .zip(ys)
                .map(|(x, y)| json!({"x":x*255.0,"y":y.clamp(0.0,1.0)*255.0}))
                .collect();
            points[0]["y"] = json!(n("blackLevel").clamp(0.0, 255.0));
            points[6]["y"] = json!((255.0 + n("whiteLevel")).clamp(0.0, 255.0));
            curves[channel] = json!(points);
        }
    } else if let Some(point_curves) = value.get("pointCurves").and_then(Value::as_object) {
        for (channel, points) in point_curves {
            curves[channel] = points.clone();
        }
    }
    value["curves"] = curves;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn linear_gradient_accepts_source_pixel_fades_and_preserves_preview_mapping() {
        let mut definition = mask();
        definition["subMasks"][0]["type"] = json!("linear");
        definition["subMasks"][0]["parameters"] = json!({
            "startX":0,"startY":2000,"endX":6960,"endY":2000,"range":1600
        });
        validate_adjustments(&json!({"masks":[definition.clone()]}), (6960, 4640)).unwrap();
        let parsed = serde_json::from_value(definition.clone()).unwrap();
        let preview =
            crate::mask_generation::generate_mask_bitmap(&parsed, 16, 400, 0.1, (0.0, 0.0), None)
                .unwrap();
        for (y, expected) in [(40, 255), (120, 191), (200, 127), (280, 63), (360, 0)] {
            assert_eq!(preview.get_pixel(0, y)[0], expected);
        }
        let crop =
            crate::mask_generation::generate_mask_bitmap(&parsed, 16, 100, 0.1, (0.0, 120.0), None)
                .unwrap();
        assert_eq!(crop.get_pixel(0, 0), preview.get_pixel(0, 120));
        for invalid in [-1, 100001] {
            definition["subMasks"][0]["parameters"]["range"] = json!(invalid);
            assert!(
                validate_adjustments(&json!({"masks":[definition.clone()]}), (6960, 4640)).is_err()
            );
        }
    }

    #[test]
    fn local_curve_updates_compile_new_ui_controls_and_preserve_explicit_native_curves() {
        let identity = default_curves();
        let mut local = json!({"curveMode":"point","curves":identity});
        let patch = json!({"curveMode":"parametric","parametricCurve":{"luma":{"shadows":50}}});
        rfc_merge(&mut local, &patch);
        resolve_curve_patch(&mut local, &patch);
        assert_ne!(
            local["curves"], identity,
            "a local UI curve edit must change native rendered curves"
        );
        let point_patch =
            json!({"curveMode":"point","pointCurves":{"luma":[{"x":0,"y":0},{"x":255,"y":180}]}});
        rfc_merge(&mut local, &point_patch);
        resolve_curve_patch(&mut local, &point_patch);
        assert_eq!(local["curves"]["luma"][1]["y"], 180);
        let explicit = json!({"curveMode":"parametric","parametricCurve":{"luma":{"shadows":-50}},"curves":identity});
        rfc_merge(&mut local, &explicit);
        resolve_curve_patch(&mut local, &explicit);
        assert_eq!(
            local["curves"], identity,
            "explicit native curves remain authoritative"
        );
    }

    fn bitmap(width: u32, height: u32) -> String {
        let image = image::DynamicImage::new_rgb8(width, height);
        let mut bytes = Cursor::new(Vec::new());
        image.write_to(&mut bytes, image::ImageFormat::Png).unwrap();
        format!(
            "data:image/png;base64,{}",
            STANDARD.encode(bytes.into_inner())
        )
    }

    fn mask() -> Value {
        json!({"id":"mask-1","name":"Subject","visible":true,"invert":false,"adjustments":{"exposure":0.5},"subMasks":[{"id":"shape-1","type":"radial","visible":true,"mode":"additive","parameters":{"centerX":50,"centerY":50,"radiusX":20,"radiusY":30,"rotation":0,"feather":0.5}}]})
    }

    #[test]
    fn texture_healing_parameters_are_opt_in_and_bounded() {
        let mut definition = mask();
        definition["subMasks"][0]["type"] = json!("heal");
        definition["subMasks"][0]["parameters"] = json!({
            "lines":[{"tool":"brush","brushSize":100,"points":[{"x":100,"y":100}]}],
            "textureOnly":true,"textureRadius":8
        });
        validate_adjustments(&json!({"masks":[definition.clone()]}), (400, 300)).unwrap();
        for radius in [0.0, 33.0] {
            definition["subMasks"][0]["parameters"]["textureRadius"] = json!(radius);
            assert!(
                validate_adjustments(&json!({"masks":[definition.clone()]}), (400, 300)).is_err()
            );
        }
    }

    #[test]
    fn defaults_match_native_ui_contract() {
        let defaults = default_adjustments();
        validate_adjustments(&defaults, (6960, 4640)).unwrap();
        assert_eq!(defaults["brightness"], 0);
        assert_eq!(defaults["lensBlurAmount"], 40);
        assert_eq!(defaults["toneMapper"], "basic");
        assert_eq!(defaults["sectionVisibility"]["details"], true);
        assert_eq!(
            defaults.as_object().unwrap().len(),
            adjustment_schema()["properties"].as_object().unwrap().len()
        );
    }

    #[test]
    fn rejects_silent_misnested_unknown_and_wrong_unit_controls() {
        for recipe in [
            json!({"adjustments":{"exposure":1}}),
            json!({"exposur":1}),
            json!({"exposure":"1"}),
            json!({"brightness":30}),
            json!({"sectionVisibility":{"detail":true}}),
            json!({"toneMapper":"filmic"}),
        ] {
            assert!(
                validate_adjustments(&recipe, (100, 80)).is_err(),
                "{recipe}"
            );
        }
    }

    #[test]
    fn crop_checks_oriented_canvas_and_positive_pixel_units() {
        validate_adjustments(
            &json!({"orientationSteps":1,"crop":{"x":0,"y":0,"width":80,"height":100,"unit":"px"}}),
            (100, 80),
        )
        .unwrap();
        for crop in [
            json!({"x":0,"y":0,"width":81,"height":100}),
            json!({"x":-1,"y":0,"width":20,"height":20}),
            json!({"x":0,"y":0,"width":0,"height":20}),
            json!({"x":0,"y":0,"width":20,"height":20,"unit":"%"}),
        ] {
            assert!(
                validate_adjustments(&json!({"orientationSteps":1,"crop":crop}), (100, 80))
                    .is_err()
            );
        }
    }

    #[test]
    fn malformed_masks_fail_instead_of_rendering_unmasked() {
        let good = mask();
        validate_adjustments(&json!({"masks":[good.clone()]}), (100, 100)).unwrap();
        for changed in [
            json!({"type":"typo"}),
            json!({"parameters":{"feather":40}}),
            json!({"mode":"multiply"}),
        ] {
            let mut bad = good.clone();
            rfc_merge(&mut bad["subMasks"][0], &changed);
            assert!(validate_adjustments(&json!({"masks":[bad]}), (100, 100)).is_err());
        }
        assert!(
            validate_adjustments(&json!({"masks":[good.clone(),good]}), (100, 100))
                .unwrap_err()
                .contains("duplicate")
        );
    }

    #[test]
    fn bitmap_and_patch_dimensions_are_verified() {
        let data = bitmap(4, 4);
        let recipe = json!({"lensBlurEnabled":true,"lensBlurDepthMap":data});
        validate_adjustments(&recipe, (100, 100)).unwrap();
        assert!(validate_adjustments(&json!({"lensBlurEnabled":true}), (100, 100)).is_err());
        assert!(
            validate_adjustments(&json!({"lensBlurDepthMap":"bm90IGFuIGltYWdl"}), (100, 100))
                .is_err()
        );
        let mut patch = mask();
        patch.as_object_mut().unwrap().remove("adjustments");
        patch["prompt"] = json!("cleanup");
        patch["patchData"] = json!({"color":bitmap(4,4),"mask":bitmap(4,4),"offsetX":2,"offsetY":3,"width":4,"height":4,"isSrgbEncoded":true});
        validate_adjustments(&json!({"aiPatches":[patch.clone()]}), (100, 100)).unwrap();
        patch["patchData"]["width"] = json!(5);
        assert!(
            validate_adjustments(&json!({"aiPatches":[patch]}), (100, 100))
                .unwrap_err()
                .contains("must match")
        );
    }

    #[test]
    fn saved_generation_tile_receipts_remain_valid_and_round_trip() {
        let mut patch = mask();
        patch.as_object_mut().unwrap().remove("adjustments");
        patch["prompt"] = json!("remove target");
        let receipt = json!({
            "seed":104729,"profile":"lama-native-tiles",
            "sourceSize":[100,100],"generatedSize":[20,15],
            "context":{"x":1,"y":2,"width":20,"height":15},
            "seconds":1.5,"processing":"native_tiles","tileSize":1024
        });
        patch["patchData"] = json!({
            "color":bitmap(4,4),"mask":bitmap(4,4),
            "offsetX":2,"offsetY":3,"width":4,"height":4,"isSrgbEncoded":true,
            "generation":receipt
        });
        let recipe = json!({"aiPatches":[patch.clone()]});
        validate_adjustments(&recipe, (100, 100)).unwrap();
        let mut restored = default_adjustments();
        merge_patch(&mut restored, &recipe).unwrap();
        assert_eq!(restored["aiPatches"][0]["patchData"]["generation"], receipt);
        validate_adjustments(&restored, (100, 100)).unwrap();

        for (key, value) in [
            ("processing", json!("unknown")),
            ("tileSize", json!(0)),
            ("tileSize", json!(8192)),
            ("generatedSize", json!([19, 15])),
        ] {
            let mut invalid = patch.clone();
            invalid["patchData"]["generation"][key] = value;
            assert!(validate_adjustments(&json!({"aiPatches":[invalid]}), (100, 100)).is_err());
        }
        patch["patchData"]["generation"]
            .as_object_mut()
            .unwrap()
            .remove("tileSize");
        assert!(validate_adjustments(&json!({"aiPatches":[patch]}), (100, 100)).is_err());
    }

    #[test]
    fn generation_options_survive_recipe_validation_with_strict_bounds() {
        let mut patch = mask();
        patch.as_object_mut().unwrap().remove("adjustments");
        patch["prompt"] = json!("cleanup");
        patch["patchData"] = json!({"color":bitmap(4,4),"mask":bitmap(4,4),"offsetX":2,"offsetY":3,"width":4,"height":4,"isSrgbEncoded":true});
        patch["generationOptions"] =
            json!({"seed":9007199254740991u64,"profile":"balanced","megapixels":2});
        let recipe = json!({"aiPatches":[patch.clone()]});
        validate_adjustments(&recipe, (100, 100)).unwrap();
        let mut restored = default_adjustments();
        merge_patch(&mut restored, &recipe).unwrap();
        assert_eq!(
            restored["aiPatches"][0]["generationOptions"],
            patch["generationOptions"]
        );
        for options in [
            json!({"seed":0}),
            json!({"seed":9007199254740992u64}),
            json!({"profile":"bad/path"}),
            json!({"megapixels":32}),
            json!({"unknown":true}),
            json!({"seed":null}),
        ] {
            patch["generationOptions"] = options;
            assert!(
                validate_adjustments(&json!({"aiPatches":[patch.clone()]}), (100, 100)).is_err()
            );
        }
    }

    #[test]
    fn curves_are_ordered_bounded_and_parametric_controls_compile() {
        for points in [
            json!([{"x":0,"y":0},{"x":0,"y":255}]),
            json!([{"x":0,"y":0},{"x":255,"y":300}]),
        ] {
            assert!(validate_adjustments(&json!({"curves":{"luma":points}}), (100, 100)).is_err());
        }
        let mut value = default_adjustments();
        merge_patch(
            &mut value,
            &json!({"curveMode":"parametric","parametricCurve":{"luma":{"shadows":50}}}),
        )
        .unwrap();
        validate_adjustments(&value, (100, 100)).unwrap();
        assert_eq!(value["curves"]["luma"].as_array().unwrap().len(), 7);
        assert!(
            value["curves"]["luma"][1]["y"].as_f64().unwrap()
                > value["curves"]["luma"][1]["x"].as_f64().unwrap()
        );
    }

    #[test]
    fn merge_is_atomic_for_unknown_keys_and_follows_rfc7396() {
        let mut base = json!({"exposure":1,"hsl":{"reds":{"hue":10,"saturation":20}},"crop":{"x":0,"y":0,"width":20,"height":20}});
        let original = base.clone();
        assert!(merge_patch(&mut base, &json!({"exposure":2,"typo":1})).is_err());
        assert_eq!(base, original);
        merge_patch(
            &mut base,
            &json!({"crop":null,"hsl":{"reds":{"hue":null,"saturation":30}},"masks":[]}),
        )
        .unwrap();
        assert!(base.get("crop").is_none());
        assert!(base["hsl"]["reds"].get("hue").is_none());
        assert_eq!(base["hsl"]["reds"]["saturation"], 30);
        assert_eq!(base["masks"], json!([]));
    }

    #[test]
    fn saved_native_curves_are_not_overwritten_by_stale_ui_bookkeeping() {
        let mut base = default_adjustments();
        let mut saved = default_adjustments();
        saved["curves"]["luma"] = json!([{"x":0,"y":12},{"x":255,"y":244}]);
        merge_patch(&mut base, &saved).unwrap();
        assert_eq!(base["curves"]["luma"], saved["curves"]["luma"]);
    }
}
