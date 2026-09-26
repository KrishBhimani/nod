export interface RasterImage {
  bytes: Uint8Array;
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
}

export function rasterImageType(bytes: Uint8Array): RasterImage['mimeType'] | null {
  const value = Buffer.from(bytes);
  const dimensions = (width: number, height: number) =>
    width > 0 && height > 0 && width <= 4096 && height <= 4096 && width * height <= 16000000;
  if (
    value.length >= 24 &&
    value.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    if (!dimensions(value.readUInt32BE(16), value.readUInt32BE(20))) return null;
    let offset = 8;
    while (offset + 12 <= value.length) {
      const length = value.readUInt32BE(offset);
      if (length > value.length - offset - 12) return null;
      const kind = value.toString('ascii', offset + 4, offset + 8);
      if (['acTL', 'fcTL', 'fdAT'].includes(kind)) return null;
      if (kind === 'IEND') return length === 0 && offset + 12 === value.length ? 'image/png' : null;
      offset += length + 12;
    }
    return null;
  }
  if (value.length >= 4 && value[0] === 255 && value[1] === 216 && value[2] === 255) {
    let offset = 2;
    while (offset + 4 <= value.length) {
      if (value[offset++] !== 255) return null;
      while (value[offset] === 255) offset++;
      const marker = value[offset++];
      if (marker === 218 || marker === 217 || offset + 2 > value.length) return null;
      const length = value.readUInt16BE(offset);
      if (length < 2 || offset + length > value.length) return null;
      if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker))
        return length >= 7 &&
          dimensions(value.readUInt16BE(offset + 5), value.readUInt16BE(offset + 3))
          ? 'image/jpeg'
          : null;
      offset += length;
    }
    return null;
  }
  if (
    value.length >= 30 &&
    value.toString('ascii', 0, 4) === 'RIFF' &&
    value.toString('ascii', 8, 12) === 'WEBP'
  ) {
    const kind = value.toString('ascii', 12, 16);
    if (kind === 'VP8X' && !(value[20] & 2))
      return dimensions(value.readUIntLE(24, 3) + 1, value.readUIntLE(27, 3) + 1)
        ? 'image/webp'
        : null;
    if (kind === 'VP8 ')
      return dimensions(value.readUInt16LE(26) & 16383, value.readUInt16LE(28) & 16383)
        ? 'image/webp'
        : null;
    if (kind === 'VP8L' && value[20] === 47)
      return dimensions(
        ((value[21] | (value[22] << 8)) & 16383) + 1,
        (((value[22] >> 6) | (value[23] << 2) | (value[24] << 10)) & 16383) + 1,
      )
        ? 'image/webp'
        : null;
  }
  return null;
}
