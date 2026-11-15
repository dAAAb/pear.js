"""The PIL side of the JPEG comparison (web/tests/jpeg_compare.py): run it with PEAR's station Python, which has
the PIL and numpy that PEAR's agent loop saves a turn's frame with.

    <station python> jpeg_reference.py scene <dir>              writes scene.png: a drawn bench with sensor noise
    <station python> jpeg_reference.py frompixels <dir> <name>  <name>.rgb (a canvas's pixels) -> <name>.png
    <station python> jpeg_reference.py samepixels <dir> <name>  whether <name>.rgb holds the pixels of <name>.png
    <station python> jpeg_reference.py encode <dir> <name>      <name>.png -> <name>.pil.jpg, as PEAR saves a frame
    <station python> jpeg_reference.py compare <dir> <name>     <name>.png, <name>.pil.jpg, <name>.browser.jpg -> JSON

The frame of a turn is saved by pear/deploy/station/agent_loop/messages.py with
`Image.fromarray(rgb).save(path, "JPEG", quality=JPEG_QUALITY)` and JPEG_QUALITY = 90; `encode` makes that call.
"""

import json
import math
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

JPEG_QUALITY = 90  # pear/deploy/station/agent_loop/messages.py
WIDTH, HEIGHT = 640, 480  # the frame PEAR asks its wrist camera for


def scene() -> np.ndarray:
    """Returns a picture with what a wrist camera sees in kind: a bench with a grain, a few objects with soft and
    hard edges, a dark gripper at the bottom, fine print, and the noise of a sensor. The same at every run."""
    random = np.random.default_rng(101)
    y, x = np.mgrid[0:HEIGHT, 0:WIDTH].astype(np.float64)
    bench = np.stack(
        [
            150 + 40 * np.sin(x / 37.0) * np.cos(y / 53.0) + 0.05 * x,
            128 + 30 * np.sin(x / 41.0 + 1.0) * np.cos(y / 47.0) + 0.04 * y,
            100 + 25 * np.sin(x / 29.0 + 2.0) * np.cos(y / 61.0),
        ],
        axis=-1,
    )
    grain = random.normal(0, 6, (HEIGHT // 4, WIDTH // 4, 1)).repeat(4, axis=0).repeat(4, axis=1)
    image = Image.fromarray(np.clip(bench + grain, 0, 255).astype(np.uint8))
    draw = ImageDraw.Draw(image)
    draw.rectangle([90, 120, 210, 240], fill=(182, 60, 40))
    draw.ellipse([330, 90, 470, 230], fill=(40, 96, 180))
    draw.polygon([(250, 330), (330, 200), (410, 330)], fill=(230, 196, 60))
    draw.rectangle([500, 260, 600, 330], fill=(245, 245, 240), outline=(20, 20, 20), width=3)
    for row in range(8):  # fine print
        draw.line([(508, 270 + 7 * row), (592 - 9 * (row % 3), 270 + 7 * row)], fill=(40, 40, 40), width=1)
    draw.polygon([(200, 480), (260, 380), (300, 380), (320, 480)], fill=(28, 28, 30))  # the fixed finger
    draw.polygon([(360, 480), (372, 400), (410, 400), (440, 480)], fill=(34, 34, 36))  # the moving jaw
    pixels = np.asarray(image).astype(np.float64)
    shade = 1.0 - 0.25 * ((x - 320) ** 2 + (y - 240) ** 2) / (320**2 + 240**2)  # darker corners
    pixels = pixels * shade[..., None] + random.normal(0, 2.0, pixels.shape)

    return np.clip(np.rint(pixels), 0, 255).astype(np.uint8)


def psnr(first: np.ndarray, second: np.ndarray) -> float | None:
    error = np.mean((first.astype(np.float64) - second.astype(np.float64)) ** 2)

    return None if error == 0 else round(10 * math.log10(255.0**2 / error), 3)


def segments(data: bytes) -> list[tuple[int, bytes]]:
    """Returns the marker segments of a JPEG up to its scan: (marker, payload)."""
    found = []
    offset = 2
    while offset + 4 <= len(data) and data[offset] == 0xFF:
        marker = data[offset + 1]
        length = int.from_bytes(data[offset + 2 : offset + 4], "big")
        found.append((marker, data[offset + 4 : offset + 2 + length]))
        if marker == 0xDA:
            break
        offset += 2 + length

    return found


def described(path: Path) -> dict:
    data = path.read_bytes()
    with Image.open(path) as image:
        parts = segments(data)
        return {
            "bytes": len(data),
            "size": list(image.size),
            "mode": image.mode,
            "progressive": bool(image.info.get("progressive", False)),
            "subsampling": {(2, 2): "4:2:0", (2, 1): "4:2:2", (1, 1): "4:4:4"}.get(image.layer[0][1:3], str(image.layer[0][1:3])),
            "quantization": {str(index): list(table) for index, table in image.quantization.items()},
            "huffman_tables": [payload.hex() for marker, payload in parts if marker == 0xC4],
            "markers": [f"{marker:02X}" for marker, _ in parts],
        }


def main() -> None:
    command, directory = sys.argv[1], Path(sys.argv[2])
    if command == "scene":
        Image.fromarray(scene()).save(directory / "scene.png")
        return

    name = sys.argv[3]
    if command in ("frompixels", "samepixels"):
        # <name>.rgb: the pixels a browser's canvas held, 640 x 480 x 3 bytes
        raw = np.frombuffer((directory / f"{name}.rgb").read_bytes(), dtype=np.uint8).reshape(HEIGHT, WIDTH, 3)
        if command == "frompixels":
            Image.fromarray(raw).save(directory / f"{name}.png")
        else:
            print(json.dumps(bool((raw == np.asarray(Image.open(directory / f"{name}.png").convert("RGB"))).all())))
        return

    source = np.asarray(Image.open(directory / f"{name}.png").convert("RGB"))
    if command == "encode":
        Image.fromarray(source).save(directory / f"{name}.pil.jpg", "JPEG", quality=JPEG_QUALITY)
        return

    pil_path, browser_path = directory / f"{name}.pil.jpg", directory / f"{name}.browser.jpg"
    pil = np.asarray(Image.open(pil_path).convert("RGB"))
    browser = np.asarray(Image.open(browser_path).convert("RGB"))
    difference = np.abs(pil.astype(np.int16) - browser.astype(np.int16))
    pil_file, browser_file = described(pil_path), described(browser_path)
    print(
        json.dumps(
            {
                "name": name,
                "source_size": [source.shape[1], source.shape[0]],
                "pil_bytes": pil_file["bytes"],
                "browser_bytes": browser_file["bytes"],
                "psnr_pil_against_source_db": psnr(pil, source),
                "psnr_browser_against_source_db": psnr(browser, source),
                "psnr_browser_against_pil_db": psnr(browser, pil),
                "decoded_pixels_identical": bool((difference == 0).all()),
                "largest_difference_of_a_channel": int(difference.max()),
                "share_of_channels_that_differ": round(float((difference > 0).mean()), 6),
                "same_quantization_tables": pil_file["quantization"] == browser_file["quantization"],
                "same_huffman_tables": pil_file["huffman_tables"] == browser_file["huffman_tables"],
                "pil": {key: pil_file[key] for key in ("size", "mode", "progressive", "subsampling", "markers")},
                "browser": {key: browser_file[key] for key in ("size", "mode", "progressive", "subsampling", "markers")},
            }
        )
    )


if __name__ == "__main__":
    main()
