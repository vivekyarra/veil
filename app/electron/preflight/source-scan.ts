import { nativeImage } from "electron";
import type { ObsClient } from "../obs/client.js";
import type { Supervisor } from "../supervisor.js";
interface Region {
  kind: string;
  box: { x: number; y: number; w: number; h: number };
}
/** Inspect visible items across scenes; return only already-masked thumbnails. */
export async function scanSources(
  obs: ObsClient,
  detector: Supervisor,
): Promise<{ source: string; image: string; kinds: string[] }[]> {
  const names = new Set<string>();
  for (const sceneName of await obs.scenes()) {
    const items = await obs.socket.call("GetSceneItemList", { sceneName });
    for (const item of items.sceneItems)
      if (item.sceneItemEnabled) names.add(String(item.sourceName));
  }
  const scans = [];
  for (const sourceName of names) {
    const screenshot = await obs.socket.call("GetSourceScreenshot", {
      sourceName,
      imageFormat: "png",
      imageWidth: 1280,
    });
    const png = nativeImage.createFromDataURL(screenshot.imageData).toPNG();
    if (!png.length) throw new Error("OBS returned an empty capture");
    const response = await fetch(detector.url + "/v1/frames", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + detector.token,
        "X-Veil-Frame": JSON.stringify({
          frame_id: 0,
          timestamp_ns: 0,
          stream_id: "preflight-" + Date.now() + "-" + scans.length,
        }),
      },
      body: new Uint8Array(png),
      signal: AbortSignal.timeout(60000),
    });
    if (!response.ok) throw new Error("Capture detection failed");
    const result = (await response.json()) as { detections: Region[] };
    const original = nativeImage.createFromBuffer(png),
      { width, height } = original.getSize();
    const pixels = original.toBitmap();
    for (const { box } of result.detections) {
      const left = Math.max(0, Math.floor(box.x * width)),
        top = Math.max(0, Math.floor(box.y * height));
      const right = Math.min(width, Math.ceil((box.x + box.w) * width)),
        bottom = Math.min(height, Math.ceil((box.y + box.h) * height));
      for (let y = top; y < bottom; y++)
        for (let x = left; x < right; x++) {
          const offset = (y * width + x) * 4;
          pixels[offset] = 24;
          pixels[offset + 1] = 24;
          pixels[offset + 2] = 24;
          pixels[offset + 3] = 255;
        }
    }
    const image = nativeImage
      .createFromBitmap(pixels, { width, height })
      .toDataURL();
    scans.push({
      source: sourceName,
      image,
      kinds: [...new Set(result.detections.map((d) => d.kind))],
    });
  }
  return scans;
}
