import { useEffect, useRef } from "react";
import type { Scan } from "../types";

/** Brand mask colour; matches the OBS plugin's default fill. */
const MASK = "#7c5cff";

export function MaskedImage({ scan, masked }: { scan: Scan; masked: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const image = new Image();
    image.onload = () => {
      const c = ref.current;
      if (!c) return;
      c.width = image.width;
      c.height = image.height;
      const ctx = c.getContext("2d")!;
      ctx.drawImage(image, 0, 0);
      if (!masked) return;
      ctx.fillStyle = MASK;
      if (scan.fullHold) {
        ctx.fillRect(0, 0, c.width, c.height);
        ctx.fillStyle = "#ffffff";
        ctx.font = "600 28px Inter, Segoe UI, Arial";
        ctx.fillText("Hold on — VEIL is checking", 70, 110);
      } else if (scan.masked)
        for (const d of scan.detections) {
          const x = d.box.x * c.width,
            y = d.box.y * c.height,
            w = d.box.w * c.width,
            h = d.box.h * c.height;
          ctx.fillRect(x, y, w, h);
          ctx.strokeStyle = "#b6a5ff";
          ctx.lineWidth = 2;
          ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
        }
    };
    image.src = scan.image;
  }, [scan, masked]);
  return (
    <canvas
      ref={ref}
      aria-label={masked ? "Rehearsal result" : "Original practice capture"}
    />
  );
}
