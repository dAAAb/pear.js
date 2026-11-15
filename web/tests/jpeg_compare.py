"""Measures how the frame of a turn differs between PEAR's encoder and the page's.

PEAR saves a frame with PIL as JPEG at quality 90; the page has the browser encode it at the same quality. This
gives both the same pixels and compares the two files: their sizes, how far each is from the pixels, how far
they are from each other, and whether they use the same quantization and Huffman tables.

    python web/tests/jpeg_compare.py --pil-python <PEAR's station python> --out <a directory outside the repository>

Needs Playwright and its Chromium for this Python, the built page (npm run build:web), and for --pil-python a
Python with PIL and numpy (PEAR's station environment). Two pictures are compared: a drawn bench with the noise
of a sensor (jpeg_reference.py), and the page's own test picture.
"""

from __future__ import annotations

import argparse
import base64
import functools
import http.server
import json
import subprocess
import sys
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright

REPOSITORY = Path(__file__).resolve().parents[2]
REFERENCE = Path(__file__).with_name("jpeg_reference.py")


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *arguments):
        pass


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dist", default=str(REPOSITORY / "dist-web"))
    parser.add_argument("--out", required=True, help="a working directory, not in the repository")
    parser.add_argument("--pil-python", required=True, help="a Python with PIL and numpy: PEAR's station Python")
    arguments = parser.parse_args()
    out = Path(arguments.out).resolve()
    if out == REPOSITORY or REPOSITORY in out.parents:
        print("--out must not be inside the repository")
        return 2
    out.mkdir(parents=True, exist_ok=True)

    def reference(*command: str) -> str:
        completed = subprocess.run(
            [arguments.pil_python, str(REFERENCE), command[0], str(out), *command[1:]], capture_output=True, timeout=120, check=False
        )
        if completed.returncode != 0:
            raise RuntimeError(completed.stderr.decode(errors="replace")[-800:])
        return completed.stdout.decode()

    reference("scene")
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=arguments.dist))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    results = []
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True, args=["--disable-gpu"])
            page = browser.new_page()
            page.goto(f"http://127.0.0.1:{server.server_address[1]}/index.html?lang=en")
            page.wait_for_function("window.pearjs !== undefined")
            version = browser.version

            # what the page makes of a picture: its pixels on a canvas, and the frame a turn would send
            encode = """async source => {
                const picture = source === null ? window.pearjs.testPicture() : await (async () => {
                    const image = new Image();
                    image.src = 'data:image/png;base64,' + source;
                    await image.decode();
                    return image;
                })();
                const canvas = document.createElement('canvas');
                canvas.width = 640; canvas.height = 480;
                const context = canvas.getContext('2d', { alpha: false });
                context.drawImage(picture, 0, 0);
                const rgba = context.getImageData(0, 0, 640, 480).data;
                const rgb = new Uint8Array(640 * 480 * 3);
                for (let index = 0; index < 640 * 480; index++) rgb.set(rgba.subarray(4 * index, 4 * index + 3), 3 * index);
                const frame = await window.pearjs.frameOf(picture, 640, 480);
                const text = bytes => { let joined = ''; for (let at = 0; at < bytes.length; at += 32768) joined += String.fromCharCode(...bytes.subarray(at, at + 32768)); return btoa(joined); };
                return { rgb: text(rgb), jpeg: text(frame.bytes), quality: frame.quality, header: frame.header };
            }"""
            for name in ("scene", "testpicture"):
                source = base64.b64encode((out / "scene.png").read_bytes()).decode() if name == "scene" else None
                made = page.evaluate(encode, source)
                (out / f"{name}.rgb").write_bytes(base64.b64decode(made["rgb"]))
                (out / f"{name}.browser.jpg").write_bytes(base64.b64decode(made["jpeg"]))
                if name == "scene":
                    same_pixels = json.loads(reference("samepixels", name))
                else:
                    reference("frompixels", name)
                    same_pixels = True
                reference("encode", name)
                result = json.loads(reference("compare", name))
                result["browser_encoded_the_same_pixels_as_pil"] = same_pixels
                result["page_quality"] = made["quality"]
                results.append(result)
            browser.close()
    finally:
        server.shutdown()
        server.server_close()

    report = {"chromium": version, "pictures": results}
    (out / "jpeg.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"Chromium {version}")
    for result in results:
        print(
            f"{result['name']}: PIL {result['pil_bytes']} bytes, browser {result['browser_bytes']} bytes "
            f"({100 * (result['browser_bytes'] / result['pil_bytes'] - 1):+.1f}%); against the pixels PIL "
            f"{result['psnr_pil_against_source_db']} dB, browser {result['psnr_browser_against_source_db']} dB; "
            f"browser against PIL {result['psnr_browser_against_pil_db']} dB, largest difference "
            f"{result['largest_difference_of_a_channel']}, {100 * result['share_of_channels_that_differ']:.2f}% of channels differ; "
            f"same quantization {result['same_quantization_tables']}, same Huffman tables {result['same_huffman_tables']}; "
            f"same pixels in {result['browser_encoded_the_same_pixels_as_pil']}; "
            f"PIL {result['pil']['subsampling']} progressive {result['pil']['progressive']}, "
            f"browser {result['browser']['subsampling']} progressive {result['browser']['progressive']}"
        )
    print(f"report: {out / 'jpeg.json'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
