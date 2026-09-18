"""Lossless source handling and explicit CFA/colour-domain contracts."""
from pathlib import Path
import hashlib
import numpy as np


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for block in iter(lambda: stream.read(4 * 1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def cfa_positions(pattern, color_desc="RGBG"):
    pattern = np.asarray(pattern)
    if pattern.shape != (2, 2):
        raise ValueError("This experimental backend supports 2 x 2 Bayer sensors only; use existing AI denoise for other inputs")
    colors = np.array(list(color_desc))[pattern]
    if sorted(colors.ravel()) != list("BGGR"):
        raise ValueError("Unsupported CFA colour pattern")
    ry, rx = np.argwhere(colors == "R")[0]
    by, bx = 1 - ry, 1 - rx
    if colors[by, bx] != "B":
        raise ValueError("Invalid Bayer phase")
    # Authors' RGBG order: G on the R row, then G on the B row.
    return [(int(ry), int(rx)), (int(ry), int(bx)), (int(by), int(bx)), (int(by), int(rx))]


def pack(mosaic, positions):
    h, w = mosaic.shape
    image = np.pad(mosaic, ((0, h % 2), (0, w % 2)), mode="edge")
    return np.stack([image[y::2, x::2] for y, x in positions]).astype(np.float32)


def unpack(planes, positions, shape):
    _, h, w = planes.shape
    out = np.empty((h * 2, w * 2), np.float32)
    for plane, (y, x) in zip(planes, positions):
        out[y::2, x::2] = plane
    return out[:shape[0], :shape[1]]


class RawFrame:
    def __init__(self, path):
        import rawpy
        self.path = Path(path).resolve()
        if not self.path.is_file():
            raise FileNotFoundError(self.path)
        self.raw = rawpy.imread(str(self.path))
        self.positions = cfa_positions(self.raw.raw_pattern, self.raw.color_desc.decode("ascii"))
        self.shape = self.raw.raw_image_visible.shape
        self.original = self.raw.raw_image_visible.copy()
        indices = [int(self.raw.raw_pattern[y, x]) for y, x in self.positions]
        self.black = np.array(self.raw.black_level_per_channel, np.float32)[indices]
        whites = self.raw.camera_white_level_per_channel
        self.white = np.array(whites if whites is not None else [self.raw.white_level] * 4, np.float32)[indices]
        self.white = np.where(self.white > self.black, self.white, self.raw.white_level)
        if np.any(self.white <= self.black):
            raise ValueError("Invalid camera black/white levels")
        self.packed = (pack(self.original, self.positions) - self.black[:, None, None]) / (self.white-self.black)[:, None, None]

    def metadata(self):
        return {"source_sha256": sha256(self.path), "sensor_shape": list(self.shape),
                "packed_order": "RGBG", "cfa_positions": self.positions,
                "black": self.black.tolist(), "white": self.white.tolist(),
                "camera_whitebalance": list(self.raw.camera_whitebalance),
                "orientation": self.raw.sizes.flip, "rawpy_colour_domain": "sRGB"}

    def render(self, packed=None):
        import rawpy
        if packed is None:
            self.raw.raw_image_visible[:] = self.original
        else:
            if packed.shape != self.packed.shape or not np.isfinite(packed).all():
                raise ValueError("Invalid denoised RAW tensor")
            counts = packed * (self.white-self.black)[:, None, None] + self.black[:, None, None]
            mosaic = unpack(counts, self.positions, self.shape)
            self.raw.raw_image_visible[:] = np.clip(np.rint(mosaic), 0, np.iinfo(self.original.dtype).max).astype(self.original.dtype)
        linear = self.raw.postprocess(output_color=rawpy.ColorSpace.sRGB, output_bps=16,
                                     no_auto_bright=True, use_camera_wb=True, gamma=(1., 1.),
                                     demosaic_algorithm=rawpy.DemosaicAlgorithm.AHD,
                                     fbdd_noise_reduction=rawpy.FBDDNoiseReductionMode.Off)
        x = linear.astype(np.float32) / 65535
        encoded = np.where(x <= .0031308, 12.92 * x, 1.055 * x ** (1/2.4) - .055)
        return np.clip(np.rint(encoded * 65535), 0, 65535).astype(np.uint16)

    def close(self):
        self.raw.close()


def save_render(path, rgb):
    import tifffile
    from PIL import ImageCms
    profile = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()
    tifffile.imwrite(path, rgb, photometric="rgb", metadata=None,
                     extratags=[(34675, "B", len(profile), profile, False)])
