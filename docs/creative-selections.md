# Shape light, colour and depth

Bring attention to the parts of a photograph that matter. RapidRAW offers three optional tools in **Masks → Add New Mask**:

| Tool                | Use it when you want to…                          | Start with                          |
| ------------------- | ------------------------------------------------- | ----------------------------------- |
| **Shape Light**     | Emphasise the shape of a face, object or building | Light direction and Strength        |
| **Surface Colour**  | Adjust a similar colour across light and shadow   | Click the colour on your photograph |
| **Depth Selection** | Adjust nearer or more distant parts of the scene  | Near, Middle or Far                 |

Each tool analyses the photo once. After that, you can refine the edit without another analysis request, including offline. Your photograph keeps its source texture and resolution. Analysis is an estimate, so inspect fine edges and the full photograph before applying a strong effect.

## Enable the tools

These source-build features are optional and disabled by default. Set up the [shared AI connector for depth](../ai-connector/MARIGOLD.md) and, for light and colour, its [surface analysis models](../ai-connector/SURFACES.md). In **Settings → Processing → AI**, enable **Depth Selection** and/or **Shape Light and Surface Colour**, then use their setup checks. Marigold powers the analysis through your existing connector and ComfyUI.

## Shape Light

1. Choose **Shape Light** from **Add New Mask**. Analysis starts automatically; a new edit begins with gentle light from above.
2. Choose **Left**, **Above**, **Right** or **Below** and adjust **Strength**. Zero removes the light effect. For an intermediate direction, open **Analysis details** and adjust the angle.
3. Judge the photograph with the mask overlay off. Facing surfaces brighten and opposing surfaces darken; the overlay shows only the facing side.
4. To restrict the effect, choose **Limit with a brush** and paint over the intended area. The brush keeps only the overlap with this edit. Select the Shape Light component again to continue adjusting it.

This is directional dodge and burn. It changes exposure; it does not move cast shadows or rebuild reflections. Start gently, especially around hair, feathers and bright highlights. Strength spans up to 1.5 exposure stops at 100%.

## Surface Colour

1. Choose **Surface Colour**. When analysis is ready, click a colour **on the photograph**. The sample marker follows crop, rotation and flips.
2. Check the mask overlay and adjust **Colour range**. Similar colours elsewhere in the frame can also be selected.
3. Use the mask's ordinary local controls to adjust exposure, saturation or contrast. To change the colour itself, expand **Recolour (optional)**, choose **Recolour to** and increase **Recolour amount**.
4. Use **Limit with a brush** to protect other objects with a similar colour. Paint the area to keep, then return to Surface Colour.

Selection uses estimated surface colour, making it less sensitive to uneven illumination than sampling the displayed pixel colour. It does not identify an object or a material. Recolouring retains source luminance and texture; bright highlights can show less colour. Black has no recolouring effect: use local exposure to darken the selection.

## Depth Selection

1. Choose **Depth Selection** and wait for analysis.
2. Choose **Near**, **Middle** or **Far**, then refine the depth range and fades below. These are starting ranges within this image, not measured distances or automatic subject selections.
3. Check the overlay, then use ordinary local adjustments. For example, choose Far and gently reduce exposure to subdue a distant background.
4. Use the existing mask **Intersect** controls with a subject or brush component if the distance range also includes areas you want to protect.

**Visualize depth** shows the saved analysis with a far-to-near legend. Depth Selection does not change the separate Lens Blur tool.

## Saved edits and analysis

**Analysis details** contains the technical light/colour maps. You can inspect them without another request; the colour map also supports precise sample placement. These views show the full analysis frame before display rotation and crop.

Saved analysis remains usable when the server is unavailable or the optional tools are disabled. Finish lens/perspective corrections and retouch before analysis. If those changes invalidate a surface edit, choose **Update analysis** or undo the change. Regenerate analysis when transferring a mask to a different photo. Use one Shape Light or Surface Colour component per adjustment mask.

The underlying saved-edit and MCP parameter names remain compatible. See the [surface API guide](../ai-connector/SURFACES.md#mcp) and [depth API guide](../ai-connector/MARIGOLD.md#use-it) for automation.
