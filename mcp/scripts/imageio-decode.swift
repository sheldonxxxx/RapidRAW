// Independent macOS ImageIO consumer used when ImageMagick lacks JXL support.
// Force actual raster materialization and PNG finalization; lazy metadata is insufficient.
import Foundation
import ImageIO
import CoreGraphics

guard CommandLine.arguments.count == 3 else {
    fputs("Usage: imageio-decode.swift input-image output.png\n", stderr)
    exit(64)
}
let input = URL(fileURLWithPath: CommandLine.arguments[1])
let output = URL(fileURLWithPath: CommandLine.arguments[2])
guard !FileManager.default.fileExists(atPath: output.path) else { exit(73) }
guard let source = CGImageSourceCreateWithURL(input as CFURL, nil) else { exit(2) }
guard let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { exit(3) }
guard let bytes = image.dataProvider?.data else { exit(4) }
let rasterBytes = CFDataGetLength(bytes)
guard image.width > 0, image.height > 0, rasterBytes >= image.bytesPerRow * image.height else { exit(5) }
let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [String: Any] ?? [:]
let gps = properties[kCGImagePropertyGPSDictionary as String] as? [String: Any] ?? [:]
guard let destination = CGImageDestinationCreateWithURL(output as CFURL, "public.png" as CFString, 1, nil) else { exit(6) }
CGImageDestinationAddImage(destination, image, nil)
guard CGImageDestinationFinalize(destination) else { exit(7) }
let result: [String: Any] = [
    "decoder": "macOS ImageIO", "width": image.width, "height": image.height,
    "bits_per_component": image.bitsPerComponent, "raster_bytes": rasterBytes,
    "source_type": CGImageSourceGetType(source).map { $0 as String } ?? "unknown",
    "png_finalized": true, "gps_present": !gps.isEmpty
]
let json = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
print(String(decoding: json, as: UTF8.self))
