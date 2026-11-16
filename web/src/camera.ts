// Not in PEAR: the wrist camera through the browser. PEAR opens its camera with lerobot's OpenCVCamera
// (pear/deploy/station/control/robots/so101/hardware/cameras.py): 640 x 480 at 30 frames a second, MJPG, the
// frame handed on as RGB without rotation, flip or crop; lerobot refuses a camera that delivers another size.
// The agent loop saves the frame with PIL as JPEG, quality 90 (agent_loop/messages.py), and that file is what a
// turn sends. Here the camera is asked for the same size and rate, the frame is drawn as it comes and encoded
// by the browser at the same quality.

import { JPEG_QUALITY } from "../../src/agent/index";
import { SO101_DEFAULT_CONFIG } from "../../src/so101/config";

const PEAR_CAMERA = SO101_DEFAULT_CONFIG.camera ?? { width: 640, height: 480, fps: 30 };
/** The frame PEAR asks its wrist camera for. */
export const FRAME_WIDTH = PEAR_CAMERA.width;
export const FRAME_HEIGHT = PEAR_CAMERA.height;
export const FRAME_RATE = PEAR_CAMERA.fps;

/** The entry of the camera list that is no camera: a picture this page draws. */
export const TEST_PICTURE_ID = "test-picture";
/** The entry that leaves the choice of the camera to the browser. */
export const DEFAULT_CAMERA_ID = "default";

export interface CameraDevice {
  id: string;
  /** The device's own name; empty until the browser may tell it. */
  label: string;
}

/** What the camera in use delivers. */
export interface FrameFormat {
  width: number;
  height: number;
  frameRate: number | null;
  /** Whether the browser rescales the camera's picture to the size asked ("crop-and-scale") or hands it on as the
   * camera makes it ("none"); null where the browser does not say. */
  resizeMode: string | null;
  /** The camera's own name. */
  label: string;
}

/** What a JPEG file says of itself in its frame header. */
export interface JpegHeader {
  width: number;
  height: number;
  isProgressive: boolean;
  components: number;
  /** "4:2:0", "4:2:2", "4:4:4", or the sampling factors where they are none of these. */
  subsampling: string;
}

export interface CapturedFrame {
  bytes: Uint8Array;
  /** A blob: URL of the bytes, for the page's image; revoked when the next frame is captured. */
  url: string;
  header: JpegHeader | null;
  /** Whether the frame has the size PEAR asks its camera for. */
  hasPearSize: boolean;
  quality: number;
}

/** Returns what the frame header of the JPEG ``bytes`` says, or null when they hold none. */
export function jpegHeader(bytes: Uint8Array): JpegHeader | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;

  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1] as number;
    if (marker === 0xff) {
      offset += 1; // a fill byte
      continue;
    }
    const length = ((bytes[offset + 2] as number) << 8) | (bytes[offset + 3] as number);
    // SOF0 to SOF15 are frame headers, but for DHT (C4), JPG (C8) and DAC (CC)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (offset + 2 + length > bytes.length || length < 8) return null;
      const height = ((bytes[offset + 5] as number) << 8) | (bytes[offset + 6] as number);
      const width = ((bytes[offset + 7] as number) << 8) | (bytes[offset + 8] as number);
      const components = bytes[offset + 9] as number;
      const factors: string[] = [];
      for (let index = 0; index < components; index++) {
        const sampling = bytes[offset + 11 + 3 * index] as number;
        factors.push(`${sampling >> 4}x${sampling & 0x0f}`);
      }
      const joined = factors.join(",");
      const subsampling =
        joined === "2x2,1x1,1x1" ? "4:2:0" : joined === "2x1,1x1,1x1" ? "4:2:2" : joined === "1x1,1x1,1x1" ? "4:4:4" : joined;

      return { width, height, isProgressive: marker === 0xc2, components, subsampling };
    }
    offset += 2 + length;
  }

  return null;
}

/** Returns the frame ``video`` shows now as a turn would send it: drawn as it is, without scaling, rotation or
 * crop, and encoded as JPEG at PEAR's quality. */
export async function captureFrame(video: HTMLVideoElement): Promise<CapturedFrame> {
  if (video.videoWidth === 0 || video.videoHeight === 0 || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
    throw new Error("The camera has not delivered a frame yet");
  }

  return frameOf(video, video.videoWidth, video.videoHeight);
}

/** Returns the picture ``source`` of ``width`` by ``height`` pixels as the JPEG a turn would send: the one way a
 * frame is made, whatever it comes from. */
export async function frameOf(source: CanvasImageSource, width: number, height: number): Promise<CapturedFrame> {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { alpha: false });
  if (context === null) throw new Error("This browser gives no 2D canvas");
  context.drawImage(source, 0, 0, width, height);

  return encodeCanvas(canvas);
}

/** Returns the picture on ``canvas`` as the JPEG a turn would send. */
export async function encodeCanvas(canvas: HTMLCanvasElement): Promise<CapturedFrame> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY / 100));
  if (blob === null) throw new Error("The browser could not encode the frame as JPEG");
  const bytes = new Uint8Array(await blob.arrayBuffer());

  return {
    bytes,
    url: URL.createObjectURL(blob),
    header: jpegHeader(bytes),
    hasPearSize: canvas.width === FRAME_WIDTH && canvas.height === FRAME_HEIGHT,
    quality: JPEG_QUALITY,
  };
}

/** A picture the page draws at the size of PEAR's frame, as a camera's stream: for a person without a camera,
 * and for a check that needs none. Something in it moves, so that a preview is seen to be live. */
export class TestPicture {
  readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;
  private frame = 0;
  private animation: number | null = null;
  private lastDrawnAt = 0;

  constructor() {
    this.canvas = document.createElement("canvas");
    this.canvas.width = FRAME_WIDTH;
    this.canvas.height = FRAME_HEIGHT;
    const context = this.canvas.getContext("2d", { alpha: false });
    if (context === null) throw new Error("This browser gives no 2D canvas");
    this.context = context;
    this.draw();
  }

  /** Starts drawing and returns the picture as a video stream. */
  start(): MediaStream {
    const step = (now: number): void => {
      if (now - this.lastDrawnAt >= 1000 / FRAME_RATE - 2) {
        this.lastDrawnAt = now;
        this.frame += 1;
        this.draw();
      }
      this.animation = requestAnimationFrame(step);
    };
    this.animation = requestAnimationFrame(step);

    return this.canvas.captureStream(FRAME_RATE);
  }

  stop(): void {
    if (this.animation !== null) cancelAnimationFrame(this.animation);
    this.animation = null;
  }

  private draw(): void {
    const context = this.context;
    const [width, height] = [this.canvas.width, this.canvas.height];

    // a bench: a grey ground with a soft gradient, and a grid a scaled or cropped frame would show
    const ground = context.createLinearGradient(0, 0, 0, height);
    ground.addColorStop(0, "#c9cdd2");
    ground.addColorStop(1, "#8d949c");
    context.fillStyle = ground;
    context.fillRect(0, 0, width, height);
    context.strokeStyle = "rgba(255, 255, 255, 0.35)";
    context.lineWidth = 1;
    for (let x = 0; x <= width; x += 80) {
      context.beginPath();
      context.moveTo(x + 0.5, 0);
      context.lineTo(x + 0.5, height);
      context.stroke();
    }
    for (let y = 0; y <= height; y += 80) {
      context.beginPath();
      context.moveTo(0, y + 0.5);
      context.lineTo(width, y + 0.5);
      context.stroke();
    }

    // colour bars along the top: a swapped colour order or a wrong colour space shows here
    const bars = ["#ffffff", "#ffd400", "#00c8d4", "#22b14c", "#d43fd1", "#e03a2f", "#2f55e0", "#111111"];
    bars.forEach((colour, index) => {
      context.fillStyle = colour;
      context.fillRect((index * width) / bars.length, 0, width / bars.length + 1, 56);
    });

    // things on the bench
    context.fillStyle = "#b5462c";
    context.fillRect(96, 250, 110, 110);
    context.fillStyle = "#2c6fb5";
    context.beginPath();
    context.arc(430, 310, 62, 0, 2 * Math.PI);
    context.fill();
    context.fillStyle = "#e8c547";
    context.beginPath();
    context.moveTo(270, 370);
    context.lineTo(340, 250);
    context.lineTo(410, 370);
    context.closePath();
    context.fill();

    // a hand that turns once in four seconds, and the frame's number
    const angle = (this.frame / (4 * FRAME_RATE)) * 2 * Math.PI;
    context.strokeStyle = "#111111";
    context.lineWidth = 6;
    context.beginPath();
    context.arc(560, 150, 48, 0, 2 * Math.PI);
    context.stroke();
    context.beginPath();
    context.moveTo(560, 150);
    context.lineTo(560 + 40 * Math.sin(angle), 150 - 40 * Math.cos(angle));
    context.stroke();

    context.fillStyle = "#111111";
    context.font = "600 22px system-ui, sans-serif";
    context.textBaseline = "top";
    context.fillText("pear.js test picture", 20, 76);
    context.font = "16px ui-monospace, monospace";
    context.fillText(`${width} x ${height}   frame ${this.frame}`, 20, 108);
    // the corners, so that a crop is seen
    context.fillStyle = "#111111";
    for (const [x, y] of [
      [0, height - 16],
      [width - 16, height - 16],
    ] as const) {
      context.fillRect(x, y, 16, 16);
    }
  }
}

/** Why a camera could not be started, by the browser's own name of the error. */
export interface CameraFailure {
  errorName: string;
  message: string;
}

export interface CameraView {
  phase: "off" | "starting" | "live" | "failed";
  devices: CameraDevice[];
  selectedId: string;
  failure: CameraFailure | null;
  format: FrameFormat | null;
  /** Whether the camera refused PEAR's size outright, so that it was started at a size of its own. */
  isFallbackSize: boolean;
  capture: CapturedFrame | null;
  /** Why the last capture failed; null when it did not. */
  captureProblem: string | null;
}

export interface CameraHooks {
  onChange: () => void;
  log: (message: string) => void;
}

/** The page's one camera: the list of video inputs, the stream in the preview, the last captured frame. */
export class CameraSession {
  readonly view: CameraView = {
    phase: "off",
    devices: [],
    selectedId: DEFAULT_CAMERA_ID,
    failure: null,
    format: null,
    isFallbackSize: false,
    capture: null,
    captureProblem: null,
  };

  private stream: MediaStream | null = null;
  private testPicture: TestPicture | null = null;
  private generation = 0;

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly hooks: CameraHooks,
  ) {
    navigator.mediaDevices?.addEventListener?.("devicechange", () => void this.refreshDevices());
  }

  /** Whether this page may use a camera at all: a browser gives none to a page that is not served securely. */
  static get isAvailable(): boolean {
    return typeof navigator.mediaDevices?.getUserMedia === "function";
  }

  /** Reads the list of video inputs; their names are empty until a camera was allowed once. */
  async refreshDevices(): Promise<void> {
    let devices: CameraDevice[] = [];
    try {
      const all = (await navigator.mediaDevices?.enumerateDevices?.()) ?? [];
      devices = all
        .filter((device) => device.kind === "videoinput" && device.deviceId !== "")
        .map((device) => ({ id: device.deviceId, label: device.label }));
    } catch (error) {
      this.hooks.log(`Listing the cameras failed: ${String(error)}`);
    }
    this.view.devices = devices;
    const known = [DEFAULT_CAMERA_ID, TEST_PICTURE_ID, ...devices.map((device) => device.id)];
    if (!known.includes(this.view.selectedId)) this.view.selectedId = DEFAULT_CAMERA_ID;
    this.hooks.onChange();
  }

  /** Starts the camera ``id`` (a device's id, the browser's default, or the test picture) in the preview. */
  async start(id: string): Promise<void> {
    const generation = ++this.generation;
    this.stopStream();
    const view = this.view;
    view.selectedId = id;
    view.phase = "starting";
    view.failure = null;
    view.format = null;
    view.isFallbackSize = false;
    this.hooks.onChange();

    try {
      let stream: MediaStream;
      if (id === TEST_PICTURE_ID) {
        this.testPicture = new TestPicture();
        stream = this.testPicture.start();
      } else {
        stream = await this.openCamera(id);
      }
      if (generation !== this.generation) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      this.stream = stream;
      this.video.srcObject = stream;
      await this.video.play();
      const track = stream.getVideoTracks()[0];
      const settings = track?.getSettings() ?? {};
      view.format = {
        width: this.video.videoWidth || settings.width || 0,
        height: this.video.videoHeight || settings.height || 0,
        frameRate: typeof settings.frameRate === "number" ? settings.frameRate : null,
        resizeMode: (settings as { resizeMode?: string }).resizeMode ?? null,
        label: id === TEST_PICTURE_ID ? "" : (track?.label ?? ""),
      };
      view.phase = "live";
      this.hooks.log(
        `Camera: ${id === TEST_PICTURE_ID ? "test picture" : track?.label || "unnamed"}, ` +
          `${view.format.width}x${view.format.height}` +
          `${view.format.frameRate === null ? "" : ` at ${Math.round(view.format.frameRate * 10) / 10} fps`}` +
          `${view.format.resizeMode === null ? "" : `, resize mode ${view.format.resizeMode}`}`,
      );
      track?.addEventListener("ended", () => {
        if (this.stream !== stream) return;
        this.stopStream();
        view.phase = "failed";
        view.failure = { errorName: "TrackEnded", message: "The camera stopped delivering frames" };
        this.hooks.log("Camera: the track ended");
        this.hooks.onChange();
      });
      // once a camera was allowed the browser tells the devices' names
      if (id !== TEST_PICTURE_ID) {
        await this.refreshDevices();
        const deviceId = settings.deviceId;
        if (id === DEFAULT_CAMERA_ID && deviceId && view.devices.some((device) => device.id === deviceId)) {
          view.selectedId = deviceId;
        }
      }
    } catch (error) {
      if (generation !== this.generation) return;
      this.stopStream();
      view.phase = "failed";
      view.failure = {
        errorName: error instanceof Error ? error.name : "Error",
        message: error instanceof Error ? error.message : String(error),
      };
      this.hooks.log(`Camera failed: ${view.failure.errorName}: ${view.failure.message}`);
    }
    this.hooks.onChange();
  }

  /** Stops the camera; the last captured frame stays. */
  stop(): void {
    this.generation += 1;
    this.stopStream();
    this.view.phase = "off";
    this.view.format = null;
    this.view.failure = null;
    this.hooks.onChange();
  }

  /** Captures the frame the preview shows now, as a turn would send it. */
  async capture(): Promise<void> {
    const view = this.view;
    try {
      const frame = await captureFrame(this.video);
      if (view.capture !== null) URL.revokeObjectURL(view.capture.url);
      view.capture = frame;
      view.captureProblem = null;
      this.hooks.log(
        `Captured: JPEG ${frame.header?.width ?? "?"}x${frame.header?.height ?? "?"}, ${frame.bytes.length} bytes, ` +
          `quality ${frame.quality}, ${frame.header?.subsampling ?? "?"}${frame.header?.isProgressive ? ", progressive" : ""}`,
      );
    } catch (error) {
      view.captureProblem = error instanceof Error ? error.message : String(error);
      this.hooks.log(`Capture failed: ${view.captureProblem}`);
    }
    this.hooks.onChange();
  }

  /** Returns the frame the preview shows now as a turn would send it, its bytes only: what the station's wrist
   * camera is fed. Null while no camera runs or it has delivered no frame; the captured frame of step 2 stays. */
  async frameBytes(): Promise<Uint8Array | null> {
    if (this.view.phase !== "live") return null;
    // a track the browser calls ended or muted delivers no frames now: what the preview still holds is old
    const track = (this.video.srcObject as MediaStream | null)?.getVideoTracks()[0];
    if (track === undefined || track.readyState !== "live" || track.muted) return null;
    try {
      const frame = await captureFrame(this.video);
      URL.revokeObjectURL(frame.url);

      return frame.bytes;
    } catch {
      return null;
    }
  }

  /** Asks the camera for PEAR's frame: exactly its size if the camera or the browser can give it, and the
   * nearest the camera has when it cannot, which the page then says. */
  private async openCamera(id: string): Promise<MediaStream> {
    const device = id === DEFAULT_CAMERA_ID ? {} : { deviceId: { exact: id } };
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          ...device,
          width: { exact: FRAME_WIDTH },
          height: { exact: FRAME_HEIGHT },
          frameRate: { ideal: FRAME_RATE },
        },
      });
    } catch (error) {
      if (!(error instanceof Error) || error.name !== "OverconstrainedError") throw error;
    }

    this.view.isFallbackSize = true;

    return navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        ...device,
        width: { ideal: FRAME_WIDTH },
        height: { ideal: FRAME_HEIGHT },
        frameRate: { ideal: FRAME_RATE },
      },
    });
  }

  private stopStream(): void {
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.testPicture?.stop();
    this.testPicture = null;
    this.video.srcObject = null;
  }
}
