// Backend-side person detection on relayed camera frames: a real pretrained
// SSD MobileNet detector (@tensorflow-models/coco-ssd, Apache-2.0) running on
// the pure-JS tf.js CPU backend. Deliberately NOT YOLOv8 — ultralytics
// weights are AGPL, this model's license is clean for the repo.
//
// Detections are labelled 'cv-person' sightings with the model's real
// confidence score — honest CV output, never a QR-style simulated marker.
import jpeg from 'jpeg-js';

let modelPromise = null;

// Lazy-load the model once (~3 s cold start while online; weights stay
// resident afterwards). Returns null when tfjs is unavailable so the backend
// keeps running with the feature simply off.
export function getPersonModel() {
  if (modelPromise === null) {
    modelPromise = Promise.all([
      import('@tensorflow/tfjs'),
      import('@tensorflow-models/coco-ssd'),
    ]).then(([, cocoSsd]) => cocoSsd.load({ base: 'lite_mobilenet_v2' }))
      .catch(() => null);
  }
  return modelPromise;
}

// Detect people in a JPEG frame. Returns [{score, bbox:[x1,y1,x2,y2] 0..1}].
export async function detectPersons(model, jpegBuf, { minScore = 0.5, maxResults = 10 } = {}) {
  let img;
  try {
    img = jpeg.decode(jpegBuf, { maxMemoryUsageInMB: 64 });
  } catch {
    return [];
  }
  if (!img?.data || !img.width || !img.height) return [];
  const tf = await import('@tensorflow/tfjs');
  const { width, height } = img;
  const tensor = tf.tensor3d(new Uint8Array(img.data.buffer), [height, width, 4]).slice([0, 0, 0], [-1, -1, 3]);
  try {
    const found = await model.detect(tensor, maxResults, minScore);
    const clamp = (v) => Math.min(1, Math.max(0, v));
    return found
      .filter((d) => d.class === 'person')
      .map((d) => ({
        score: d.score,
        bbox: [
          clamp(d.bbox[0] / width), clamp(d.bbox[1] / height),
          clamp((d.bbox[0] + d.bbox[2]) / width), clamp((d.bbox[1] + d.bbox[3]) / height),
        ],
      }));
  } finally {
    tensor.dispose();
  }
}
