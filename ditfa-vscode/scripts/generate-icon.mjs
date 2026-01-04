/**
 * Builds media/icon.png, the 256x256 marketplace tile, from the brand mark in
 * media/ditfa.png.
 *
 * The source art is a large transparent PNG with generous empty margins, which
 * would render as a tiny logo in a 256px tile. This trims to the actual ink,
 * downsamples with a box filter, and composites the result onto a solid black
 * square, so the tile looks identical on light and dark marketplace themes.
 *
 * Run after changing the brand mark:  node scripts/generate-icon.mjs
 */
import { deflateSync, inflateSync } from "node:zlib";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = resolve(HERE, "../media/ditfa.png");
const TARGET = resolve(HERE, "../media/icon.png");

const SIZE = 256;
/** Fraction of the tile the mark occupies, leaving optical breathing room. */
const MARK_SCALE = 0.7;
/** Solid black, edge to edge — no rounding, no transparency. */
const PLATE = [0, 0, 0];

function main() {
  const source = decodePng(readFileSync(SOURCE));
  const trimmed = trimToInk(source);
  const square = padToSquare(trimmed);
  const marked = Math.round(SIZE * MARK_SCALE);
  const mark = downsample(square, marked);

  const canvas = { width: SIZE, height: SIZE, data: Buffer.alloc(SIZE * SIZE * 4) };
  paintPlate(canvas);
  compositeCentered(canvas, mark);

  writeFileSync(TARGET, encodePng(canvas));
  console.log(
    `[generate-icon] ${source.width}x${source.height} -> trimmed ${trimmed.width}x${trimmed.height} -> ${SIZE}x${SIZE}`,
  );
}

// ------------------------------------------------------------------ painting

function paintPlate(canvas) {
  for (let offset = 0; offset < canvas.data.length; offset += 4) {
    canvas.data[offset] = PLATE[0];
    canvas.data[offset + 1] = PLATE[1];
    canvas.data[offset + 2] = PLATE[2];
    canvas.data[offset + 3] = 255;
  }
}

function compositeCentered(canvas, mark) {
  const originX = Math.round((canvas.width - mark.width) / 2);
  const originY = Math.round((canvas.height - mark.height) / 2);

  for (let y = 0; y < mark.height; y += 1) {
    for (let x = 0; x < mark.width; x += 1) {
      const src = (y * mark.width + x) * 4;
      const alpha = mark.data[src + 3] / 255;
      if (alpha === 0) {
        continue;
      }
      const canvasX = originX + x;
      const canvasY = originY + y;
      if (canvasX < 0 || canvasY < 0 || canvasX >= canvas.width || canvasY >= canvas.height) {
        continue;
      }
      const dst = (canvasY * canvas.width + canvasX) * 4;
      for (let channel = 0; channel < 3; channel += 1) {
        canvas.data[dst + channel] = Math.round(
          mark.data[src + channel] * alpha + canvas.data[dst + channel] * (1 - alpha),
        );
      }
      canvas.data[dst + 3] = Math.max(canvas.data[dst + 3], mark.data[src + 3]);
    }
  }
}


// ------------------------------------------------------------ image geometry

/** Crops away fully transparent borders so the mark fills the tile. */
function trimToInk(image) {
  let minX = image.width;
  let minY = image.height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      if (image.data[(y * image.width + x) * 4 + 3] > 8) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < 0) {
    throw new Error(`${SOURCE} is fully transparent`);
  }
  return crop(image, minX, minY, maxX - minX + 1, maxY - minY + 1);
}

function crop(image, x0, y0, width, height) {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const from = ((y0 + y) * image.width + x0) * 4;
    image.data.copy(data, y * width * 4, from, from + width * 4);
  }
  return { width, height, data };
}

/** Centers the mark in a transparent square so downsampling keeps its aspect. */
function padToSquare(image) {
  const side = Math.max(image.width, image.height);
  const data = Buffer.alloc(side * side * 4);
  const offsetX = Math.floor((side - image.width) / 2);
  const offsetY = Math.floor((side - image.height) / 2);
  for (let y = 0; y < image.height; y += 1) {
    const from = y * image.width * 4;
    image.data.copy(data, ((offsetY + y) * side + offsetX) * 4, from, from + image.width * 4);
  }
  return { width: side, height: side, data };
}

/**
 * Box-filter downsample in premultiplied alpha, so transparent pixels do not
 * bleed their (undefined) colour into the edges of the mark.
 */
function downsample(image, size) {
  const data = Buffer.alloc(size * size * 4);
  const ratio = image.width / size;

  for (let y = 0; y < size; y += 1) {
    const y0 = Math.floor(y * ratio);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * ratio));
    for (let x = 0; x < size; x += 1) {
      const x0 = Math.floor(x * ratio);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * ratio));

      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let count = 0;

      for (let sy = y0; sy < y1 && sy < image.height; sy += 1) {
        for (let sx = x0; sx < x1 && sx < image.width; sx += 1) {
          const offset = (sy * image.width + sx) * 4;
          const alpha = image.data[offset + 3] / 255;
          r += image.data[offset] * alpha;
          g += image.data[offset + 1] * alpha;
          b += image.data[offset + 2] * alpha;
          a += image.data[offset + 3];
          count += 1;
        }
      }

      const out = (y * size + x) * 4;
      if (count === 0 || a === 0) {
        continue;
      }
      const meanAlpha = a / count / 255;
      data[out] = clamp(r / count / meanAlpha);
      data[out + 1] = clamp(g / count / meanAlpha);
      data[out + 2] = clamp(b / count / meanAlpha);
      data[out + 3] = clamp(a / count);
    }
  }

  return { width: size, height: size, data };
}

function clamp(value) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

// ---------------------------------------------------------------- PNG codec

function decodePng(buffer) {
  if (buffer.readUInt32BE(0) !== 0x89504e47) {
    throw new Error("not a PNG");
  }

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat = [];

  let offset = 8;
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const body = buffer.subarray(offset + 8, offset + 8 + length);

    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      bitDepth = body[8];
      colorType = body[9];
      if (body[12] !== 0) {
        throw new Error("interlaced PNGs are not supported");
      }
    } else if (type === "IDAT") {
      idat.push(body);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }

  if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2)) {
    throw new Error(`unsupported PNG: bit depth ${bitDepth}, colour type ${colorType}`);
  }

  const channels = colorType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = Buffer.alloc(width * height * 4);
  let previous = Buffer.alloc(stride);

  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1);
    const filter = raw[rowStart];
    const row = Buffer.from(raw.subarray(rowStart + 1, rowStart + 1 + stride));
    unfilter(filter, row, previous, channels);

    for (let x = 0; x < width; x += 1) {
      const from = x * channels;
      const to = (y * width + x) * 4;
      pixels[to] = row[from];
      pixels[to + 1] = row[from + 1];
      pixels[to + 2] = row[from + 2];
      pixels[to + 3] = channels === 4 ? row[from + 3] : 255;
    }
    previous = row;
  }

  return { width, height, data: pixels };
}

function unfilter(filter, row, previous, bpp) {
  switch (filter) {
    case 0:
      return;
    case 1:
      for (let i = bpp; i < row.length; i += 1) {
        row[i] = (row[i] + row[i - bpp]) & 0xff;
      }
      return;
    case 2:
      for (let i = 0; i < row.length; i += 1) {
        row[i] = (row[i] + previous[i]) & 0xff;
      }
      return;
    case 3:
      for (let i = 0; i < row.length; i += 1) {
        const left = i >= bpp ? row[i - bpp] : 0;
        row[i] = (row[i] + ((left + previous[i]) >> 1)) & 0xff;
      }
      return;
    case 4:
      for (let i = 0; i < row.length; i += 1) {
        const left = i >= bpp ? row[i - bpp] : 0;
        const up = previous[i];
        const upLeft = i >= bpp ? previous[i - bpp] : 0;
        row[i] = (row[i] + paeth(left, up, upLeft)) & 0xff;
      }
      return;
    default:
      throw new Error(`unknown PNG filter ${filter}`);
  }
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function encodePng(image) {
  const stride = image.width * 4;
  const raw = Buffer.alloc((stride + 1) * image.height);
  for (let y = 0; y < image.height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter type: none
    image.data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(image.width, 0);
  ihdr.writeUInt32BE(image.height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

main();
