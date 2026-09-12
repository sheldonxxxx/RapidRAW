# Spherical photo handoff

RapidRAW edits the handed-off pixels. Stitch camera-native fisheyes and choose spherical orientation in a separately verified panorama workflow before opening an isolated derivative here. A 2:1 raster can contain two fisheye circles; dimensions and a camera brand alone do not identify a full-sphere equirectangular image.

## Qualify a stitched RAW handoff

Prefer a verified stitched DNG when substantial tonal or white-balance work is needed and the capture has a RAW companion. Preserve that camera RAW and its paired INSP separately from the stitched derivative. Studio-exported DNG can be three-channel LinearRaw rather than a camera mosaic; inspect its decoded representation, black/white levels and actual native render before choosing an edit. A DNG extension or 16-bit container alone does not establish usable RAW latitude or correct colour.

Some LinearRaw files repeat the same per-channel black levels over a spatial grid. Use a build with correct normalization of that representation. An almost-white first render can be an importer defect rather than an overexposed capture: inspect the unadjusted render and source levels before compensating with exposure sliders. Do not rewrite the source metadata to conceal an import failure.

For a developed intermediate, export RGB16 TIFF with the editor's verified sRGB profile and inspect the returned bit-depth result. This retains precision for subsequent resampling and finishing, but is a rendered, display-referred image: it is not a new RAW master, and converting an existing JPEG to TIFF cannot restore lost values. Keep the DNG session available for revisions to foundational tone and colour.

## Preserve a full sphere

Keep the entire equirectangular canvas and its orientation. Ordinary crop, planar rotation, perspective correction, lens distortion, lens vignetting and lens chromatic correction are not spherical operations. Inspect the fresh session's adjustment state and disable inherited lens corrections rather than applying camera calibration again to already stitched pixels. Do not use an ordinary crop to level a sphere.

Begin with changes justified across the scene. Local masks, sharpening, clarity, blur and denoising may treat the longitude boundary as two unrelated image edges; do not assume the engine wraps them. Check both sides of that boundary in a continuous spherical view, at matched scale against the baseline. Also inspect the source stitch seams, zenith, nadir, nearby faces/structures and any changed texture. Avoid or revise an operation that creates a new discontinuity. A seam statistic or an unchanged 2:1 size cannot certify spherical continuity.

Render and export at the intended resolution; omit resize options for original dimensions. Keep the baseline, recipe and native session. A spherical workflow may need a separate metadata-preserving export step after RapidRAW: verify the final JPEG's full-sphere GPano projection and extent fields, decoded dimensions and ICC profile. Reopen that exact final file in a spherical viewer. A successfully decoded JPEG or embedded sRGB ICC is not proof that a viewer will recognize it as 360.

## Edit a selected flat view

Select the viewing direction, pitch and field of view from actual perspective candidates. Produce the selected rectilinear derivative from the unedited stitched baseline, then open it as a separate RapidRAW session when the task asks to reframe first and edit afterward. Record source hash, projection, angles, dimensions and sampling method with the edit. Review the flat composition on its own terms: geometry and subject scale change which tonal or local emphasis is useful.

When the source is stitched RAW, establish its foundational development before handing a rendered intermediate to a reframe tool. Use a precision-preserving RGB16 TIFF reframe, then open that flat TIFF for composition-specific finishing. A tool that converts to 8-bit JPEG before reframing limits subsequent edits even if the starting file was RAW. If a qualified tool exports a rectilinear DNG directly, test its geometry and native RAW rendering separately before using it as an alternative.

A rectilinear reframe needs no full-sphere GPano tags. Confirm they are absent in the final flat file, while preserving the intended colour profile. Output pixels are resampling dimensions, not evidence of newly resolved scene detail; choose framing and delivery size with the source's angular resolution and visible softness in mind.

## Colour and source limits

An SDK JPEG can arrive without an ICC profile. Record the working interpretation used for that untagged input; embedding sRGB on export does not retrospectively measure its colour. Judge the handoff against the actual source rendering and any supplied colour references.

Keep native stitching failures separate from RapidRAW edits. Selecting a different frame can change exposure, motion and native calibration availability even within one capture. Preserve the failed attempt and link the accepted derivative to its actual source. Motion blur, near-lens parallax and clipped light are source or stitch limitations; a stronger grade or sharper reframe must not be described as recovered detail without evidence.
