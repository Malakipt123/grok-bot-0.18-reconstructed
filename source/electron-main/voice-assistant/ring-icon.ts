// The Jarvis icon, a cyan ring like the HUD's arc reactor, drawn in code so
// the repository needs no binary icon files. Used for the tray and, as an
// .ico, for the Windows installer and Start menu shortcut.

/** Straight (not premultiplied) BGRA pixels, top row first. */
export function ringIcon(size = 32): Buffer {
  const pixels = Buffer.alloc(size * size * 4);
  const centre = (size - 1) / 2;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const distance = Math.hypot(x - centre, y - centre) / (size / 2);
      const ring = Math.max(0, 1 - Math.abs(distance - 0.72) / 0.14);
      const core = Math.max(0, 1 - distance / 0.32);
      const alpha = Math.round(255 * Math.min(1, ring + core));
      const offset = (y * size + x) * 4;
      pixels[offset] = 255;
      pixels[offset + 1] = 220;
      pixels[offset + 2] = 80;
      pixels[offset + 3] = alpha;
    }
  }
  return pixels;
}

/** A Windows .ico holding the ring at several sizes, as 32-bit bitmaps. */
export function ringIco(sizes: readonly number[] = [16, 24, 32, 48, 64, 256]): Buffer {
  const images = sizes.map((size) => {
    const pixels = ringIcon(size);
    const maskRowBytes = Math.ceil(size / 32) * 4;
    const header = Buffer.alloc(40);
    header.writeUInt32LE(40, 0);
    header.writeInt32LE(size, 4);
    header.writeInt32LE(size * 2, 8); // colour rows plus the (unused) AND mask
    header.writeUInt16LE(1, 12);
    header.writeUInt16LE(32, 14);
    header.writeUInt32LE(size * size * 4 + maskRowBytes * size, 20);
    const rows: Buffer[] = [];
    for (let y = size - 1; y >= 0; y -= 1) rows.push(pixels.subarray(y * size * 4, (y + 1) * size * 4)); // bottom-up
    return Buffer.concat([header, ...rows, Buffer.alloc(maskRowBytes * size)]);
  });
  const directory = Buffer.alloc(6 + 16 * images.length);
  directory.writeUInt16LE(1, 2);
  directory.writeUInt16LE(images.length, 4);
  let offset = directory.length;
  images.forEach((image, index) => {
    const entry = 6 + index * 16;
    const size = sizes[index]!;
    directory.writeUInt8(size >= 256 ? 0 : size, entry);
    directory.writeUInt8(size >= 256 ? 0 : size, entry + 1);
    directory.writeUInt16LE(1, entry + 4);
    directory.writeUInt16LE(32, entry + 6);
    directory.writeUInt32LE(image.length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += image.length;
  });
  return Buffer.concat([directory, ...images]);
}
