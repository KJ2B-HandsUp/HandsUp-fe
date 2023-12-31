import { drawConnectors, drawLandmarks } from "@mediapipe/drawing_utils";
import { HAND_CONNECTIONS, Results } from "@mediapipe/hands";

export const drawCanvas = (ctx: CanvasRenderingContext2D, results: Results) => {
  const width = ctx.canvas.width;
  const height = ctx.canvas.height;

  ctx.save();
  ctx.clearRect(0, 0, width, height);

  ctx.scale(-1, 1);
  ctx.translate(-width, 0);

  ctx.drawImage(results.image, 0, 0, width, height);

  if (results.multiHandLandmarks) {
    for (const landmarks of results.multiHandLandmarks) {
      drawConnectors(ctx, landmarks, HAND_CONNECTIONS, {
        color: "#00FF00",
        lineWidth: 5,
      });
      drawLandmarks(ctx, landmarks, {
        color: "#FF0000",
        lineWidth: 1,
        radius: 5,
      });
    }
  }
  ctx.restore();
};
