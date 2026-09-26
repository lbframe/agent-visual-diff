#!/usr/bin/env node
/**
 * Deterministic bug injector for the mask benchmark.
 *
 * Writes a copy of a PNG with one synthetic defect applied, so a run can prove
 * that a real diff outside the mask is still detected. Same input, same output
 * bytes, every time.
 *
 *   node bench/inject-bug.mjs <in.png> <out.png> <op> <x> <y> <w> <h> [arg]
 *
 *   op = fill   arg = "r,g,b"  flood a rect with a solid colour (missing asset/style)
 *   op = shift  arg = dx       shift a horizontal band left/right (layout regression)
 */
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';

const [input, output, op, ...rest] = process.argv.slice(2);
if (!input || !output || !op || rest.length < 5) {
  process.stderr.write('usage: inject-bug.mjs <in.png> <out.png> <fill|shift> <x> <y> <w> <h> [arg]\n');
  process.exit(1);
}

const [x, y, w, h] = rest.slice(0, 4).map(Number);
const arg = rest[4];
const png = PNG.sync.read(fs.readFileSync(input));

for (let row = y; row < y + h; row++) {
  if (row < 0 || row >= png.height) continue;
  for (let col = x; col < x + w; col++) {
    if (col < 0 || col >= png.width) continue;

    if (op === 'fill') {
      const [r, g, b] = String(arg).split(',').map(Number);
      const i = (row * png.width + col) * 4;
      png.data[i] = r;
      png.data[i + 1] = g;
      png.data[i + 2] = b;
      png.data[i + 3] = 255;
      continue;
    }

    if (op === 'shift') {
      const dx = Number(arg);
      const from = (row * png.width + col) * 4;
      const source = from - dx * 4;
      if (source < 0 || source + 3 >= png.data.length) continue;
      png.data[from] = png.data[source];
      png.data[from + 1] = png.data[source + 1];
      png.data[from + 2] = png.data[source + 2];
      png.data[from + 3] = png.data[source + 3];
    }
  }
}

fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
fs.writeFileSync(output, PNG.sync.write(png));
process.stdout.write(`${output}\n`);
