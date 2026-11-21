/**
 * Pure zero-DOM perceptual fingerprint math shared between the off-main-thread
 * Fingerprint Web Worker and the main-thread fallback in `visualSimilarity.ts`.
 */

export interface VisualFingerprint {
  /** 16x16 spatially smoothed, Z-normalized luminance grid (exposure-invariant) */
  lumaGrid: Float32Array;
  /** 16x16 smoothed Sobel edge-density map, Z-normalized (contour/texture layout) */
  edgeGrid: Float32Array;
  /** 8x8 perceptual opponent-color grid [L, R-G, Y-B] in [0..1 / -1..1] (192 floats) */
  spatialColor: Float32Array;
  /** 4x4x4 quantized RGB color histogram normalized to sum = 1.0 (64 floats) */
  colorHist: Float32Array;
  /** Mean normalized scene brightness (0..1) */
  meanLuma: number;
  /** Image aspect ratio (width / height) */
  aspectRatio: number;
}

function zNormalize256(grid: Float32Array): void {
  let mean = 0;
  for (let i = 0; i < 256; i++) mean += grid[i];
  mean /= 256;

  let variance = 0;
  for (let i = 0; i < 256; i++) {
    const d = grid[i] - mean;
    variance += d * d;
  }
  const std = Math.sqrt(variance / 256);
  if (std > 1e-4) {
    for (let i = 0; i < 256; i++) {
      grid[i] = (grid[i] - mean) / std;
    }
  } else {
    grid.fill(0);
  }
}

/**
 * Computes the perceptual VisualFingerprint directly from a 32x32 RGBA pixel buffer
 * plus the source image's natural width and height.
 */
export function computeFingerprintFromRgba32x32(
  pixels: Uint8ClampedArray,
  width: number,
  height: number
): VisualFingerprint | null {
  if (width <= 0 || height <= 0 || pixels.length < 32 * 32 * 4) return null;

  // 1. Extract 32x32 luma + 4x4x4 (64-bin) normalized RGB histogram
  const rawLuma = new Float32Array(1024);
  const colorHist = new Float32Array(64);
  let minLuma = 255;
  let maxLuma = 0;
  let totalLuma = 0;

  for (let i = 0; i < 1024; i++) {
    const p = i * 4;
    const r = pixels[p];
    const g = pixels[p + 1];
    const b = pixels[p + 2];

    const luma = 0.299 * r + 0.587 * g + 0.114 * b;
    rawLuma[i] = luma;
    totalLuma += luma;
    if (luma < minLuma) minLuma = luma;
    if (luma > maxLuma) maxLuma = luma;

    const rBin = Math.min(3, (r * 4) >> 8);
    const gBin = Math.min(3, (g * 4) >> 8);
    const bBin = Math.min(3, (b * 4) >> 8);
    colorHist[rBin * 16 + gBin * 4 + bBin] += 1 / 1024;
  }

  // Reject blank/solid error frames
  if (maxLuma - minLuma < 2) {
    return null;
  }

  const meanLuma = totalLuma / (1024 * 255);

  // 2. Apply gentle 3x3 Gaussian blur on 32x32 luma before 16x16 downsampling
  const smoothLuma = new Float32Array(1024);
  const rawGrad = new Float32Array(1024);

  for (let y = 0; y < 32; y++) {
    const ym1 = y > 0 ? y - 1 : 0;
    const yp1 = y < 31 ? y + 1 : 31;
    for (let x = 0; x < 32; x++) {
      const xm1 = x > 0 ? x - 1 : 0;
      const xp1 = x < 31 ? x + 1 : 31;

      const tl = rawLuma[ym1 * 32 + xm1];
      const tc = rawLuma[ym1 * 32 + x];
      const tr = rawLuma[ym1 * 32 + xp1];
      const ml = rawLuma[y * 32 + xm1];
      const mc = rawLuma[y * 32 + x];
      const mr = rawLuma[y * 32 + xp1];
      const bl = rawLuma[yp1 * 32 + xm1];
      const bc = rawLuma[yp1 * 32 + x];
      const br = rawLuma[yp1 * 32 + xp1];

      smoothLuma[y * 32 + x] =
        (tl + 2 * tc + tr + 2 * ml + 4 * mc + 2 * mr + bl + 2 * bc + br) / 16;

      // Sobel gradient magnitude on 32x32 luma
      const gx = tr + 2 * mr + br - (tl + 2 * ml + bl);
      const gy = bl + 2 * bc + br - (tl + 2 * tc + tr);
      rawGrad[y * 32 + x] = Math.hypot(gx, gy);
    }
  }

  // Soften 32x32 gradient map so sub-cell jitter doesn't break contour matching
  const smoothGrad = new Float32Array(1024);
  for (let y = 0; y < 32; y++) {
    const ym1 = y > 0 ? y - 1 : 0;
    const yp1 = y < 31 ? y + 1 : 31;
    for (let x = 0; x < 32; x++) {
      const xm1 = x > 0 ? x - 1 : 0;
      const xp1 = x < 31 ? x + 1 : 31;
      smoothGrad[y * 32 + x] =
        (rawGrad[ym1 * 32 + xm1] +
          2 * rawGrad[ym1 * 32 + x] +
          rawGrad[ym1 * 32 + xp1] +
          2 * rawGrad[y * 32 + xm1] +
          4 * rawGrad[y * 32 + x] +
          2 * rawGrad[y * 32 + xp1] +
          rawGrad[yp1 * 32 + xm1] +
          2 * rawGrad[yp1 * 32 + x] +
          rawGrad[yp1 * 32 + xp1]) /
        16;
    }
  }

  // 3. Downsample to 16x16 lumaGrid and 16x16 edgeGrid, then Z-normalize both
  const lumaGrid = new Float32Array(256);
  const edgeGrid = new Float32Array(256);
  for (let by = 0; by < 16; by++) {
    const sy = by * 2;
    for (let bx = 0; bx < 16; bx++) {
      const sx = bx * 2;
      const i00 = sy * 32 + sx;
      const i01 = sy * 32 + sx + 1;
      const i10 = (sy + 1) * 32 + sx;
      const i11 = (sy + 1) * 32 + sx + 1;
      lumaGrid[by * 16 + bx] =
        (smoothLuma[i00] + smoothLuma[i01] + smoothLuma[i10] + smoothLuma[i11]) *
        0.25;
      edgeGrid[by * 16 + bx] =
        (smoothGrad[i00] + smoothGrad[i01] + smoothGrad[i10] + smoothGrad[i11]) *
        0.25;
    }
  }

  zNormalize256(lumaGrid);
  zNormalize256(edgeGrid);

  // 4. Compute 8x8 perceptual spatial color grid [L, R-G, Y-B] (4x4 pixels per cell)
  const spatialColor = new Float32Array(192);
  for (let cy = 0; cy < 8; cy++) {
    for (let cx = 0; cx < 8; cx++) {
      let lSum = 0;
      let rgSum = 0;
      let ybSum = 0;
      for (let dy = 0; dy < 4; dy++) {
        const y = cy * 4 + dy;
        for (let dx = 0; dx < 4; dx++) {
          const x = cx * 4 + dx;
          const p = (y * 32 + x) * 4;
          const r = pixels[p];
          const g = pixels[p + 1];
          const b = pixels[p + 2];
          lSum += 0.299 * r + 0.587 * g + 0.114 * b;
          rgSum += r - g;
          ybSum += 0.5 * (r + g) - b;
        }
      }
      const norm = 16 * 255;
      const cellIdx = (cy * 8 + cx) * 3;
      spatialColor[cellIdx] = lSum / norm;
      spatialColor[cellIdx + 1] = rgSum / norm;
      spatialColor[cellIdx + 2] = ybSum / norm;
    }
  }

  return {
    lumaGrid,
    edgeGrid,
    spatialColor,
    colorHist,
    meanLuma,
    aspectRatio: width / height,
  };
}
