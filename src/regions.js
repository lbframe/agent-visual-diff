/** Deterministic 8-connected component labelling over a Uint8Array mask. */
export function connectedComponents(mask, width, height, minPixels = 1) {
  if (mask.length !== width * height) throw new Error('mask size does not match dimensions');
  const seen = new Uint8Array(mask.length);
  const regions = [];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const start = y * width + x;
      if (!mask[start] || seen[start]) continue;

      const stack = [start];
      seen[start] = 1;
      let minX = x, maxX = x, minY = y, maxY = y, px = 0;

      while (stack.length) {
        const idx = stack.pop();
        const cy = Math.floor(idx / width);
        const cx = idx - cy * width;
        px++;
        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;

        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = cx + dx, ny = cy + dy;
            if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
            const ni = ny * width + nx;
            if (mask[ni] && !seen[ni]) {
              seen[ni] = 1;
              stack.push(ni);
            }
          }
        }
      }

      if (px >= minPixels) {
        regions.push({ x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1, px });
      }
    }
  }
  return regions;
}

function intervalGap(a0, a1, b0, b1) {
  if (a1 < b0) return b0 - a1 - 1;
  if (b1 < a0) return a0 - b1 - 1;
  return 0;
}

function closeEnough(a, b, gap) {
  const ax1 = a.x + a.w - 1, ay1 = a.y + a.h - 1;
  const bx1 = b.x + b.w - 1, by1 = b.y + b.h - 1;
  return intervalGap(a.x, ax1, b.x, bx1) <= gap && intervalGap(a.y, ay1, b.y, by1) <= gap;
}

function mergeTwo(a, b) {
  const x0 = Math.min(a.x, b.x), y0 = Math.min(a.y, b.y);
  const x1 = Math.max(a.x + a.w - 1, b.x + b.w - 1);
  const y1 = Math.max(a.y + a.h - 1, b.y + b.h - 1);
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1, px: a.px + b.px };
}

/** Merge nearby components deterministically. Useful for text/icons split into tiny islands. */
export function mergeRegions(input, gap = 6) {
  const regions = input.map(r => ({ ...r }));
  let changed = true;
  while (changed) {
    changed = false;
    outer: for (let i = 0; i < regions.length; i++) {
      for (let j = i + 1; j < regions.length; j++) {
        if (closeEnough(regions[i], regions[j], gap)) {
          regions[i] = mergeTwo(regions[i], regions[j]);
          regions.splice(j, 1);
          changed = true;
          break outer;
        }
      }
    }
  }
  return regions;
}

export function padAndClampRegions(regions, width, height, padding = 0) {
  return regions.map(r => {
    const x0 = Math.max(0, r.x - padding);
    const y0 = Math.max(0, r.y - padding);
    const x1 = Math.min(width - 1, r.x + r.w - 1 + padding);
    const y1 = Math.min(height - 1, r.y + r.h - 1 + padding);
    return { ...r, x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  });
}

export function sortRegions(regions) {
  return regions.sort((a, b) => b.px - a.px || a.y - b.y || a.x - b.x || b.w * b.h - a.w * a.h);
}
