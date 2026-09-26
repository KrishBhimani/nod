import assert from 'node:assert/strict';
import { crc32 } from 'node:zlib';
import test from 'node:test';
import { rasterImageType } from '../src/providers/raster-image.ts';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAEElEQVR4nGP8w4AALAxEcQAz1AEKG5dMywAAAABJRU5ErkJggg==',
  'base64',
);
const jpeg = Buffer.from(
  '/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYyLjExLjEwMAD/2wBDAAgEBAQEBAUFBQUFBQYGBgYGBgYGBgYGBgYHBwcICAgHBwcGBgcHCAgICAkJCQgICAgJCQoKCgwMCwsODg4RERT/xABMAAEBAAAAAAAAAAAAAAAAAAAABgEBAQAAAAAAAAAAAAAAAAAABgcQAQAAAAAAAAAAAAAAAAAAAAARAQAAAAAAAAAAAAAAAAAAAAD/wAARCAAEAAQDASIAAhEAAxEA/9oADAMBAAIRAxEAPwCLAE1/f//Z',
  'base64',
);
const webp = Buffer.from(
  'UklGRjwAAABXRUJQVlA4IDAAAADQAQCdASoEAAQAAgA0JaACdLoB+AADsAD+8Oj3/yC5YXXI1/8gP+QH/ID/+PIAAAA=',
  'base64',
);
const losslessWebp = Buffer.from('UklGRhwAAABXRUJQVlA4TA8AAAAvA8AAAAcQ9Y/+ByKi/wEA', 'base64');

function pngChunk(kind: string, body: Buffer) {
  const chunk = Buffer.alloc(body.length + 12);
  chunk.writeUInt32BE(body.length);
  chunk.write(kind, 4);
  body.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
  return chunk;
}

function riff(...chunks: Buffer[]) {
  const header = Buffer.from('RIFF\x00\x00\x00\x00WEBP', 'ascii');
  header.writeUInt32LE(4 + chunks.reduce((total, chunk) => total + chunk.length, 0), 4);
  return Buffer.concat([header, ...chunks]);
}

function webpChunk(kind: string, body: Buffer) {
  const chunk = Buffer.alloc(8 + body.length + (body.length % 2));
  chunk.write(kind);
  chunk.writeUInt32LE(body.length, 4);
  body.copy(chunk, 8);
  return chunk;
}

test('raster detection accepts complete static PNG, JPEG and WebP fixtures', () => {
  for (const [bytes, type] of [
    [png, 'image/png'],
    [jpeg, 'image/jpeg'],
    [webp, 'image/webp'],
    [losslessWebp, 'image/webp'],
  ] as const)
    assert.equal(rasterImageType(bytes), type);
  const extended = Buffer.alloc(10);
  extended.writeUIntLE(3, 4, 3);
  extended.writeUIntLE(3, 7, 3);
  assert.equal(rasterImageType(riff(webpChunk('VP8X', extended), webp.subarray(12))), 'image/webp');
});

test('PNG requires a first image header, intact chunks, consecutive image data and an exact ending', () => {
  const signature = png.subarray(0, 8);
  const header = png.subarray(8, 33);
  const data = png.subarray(54, -12);
  const end = png.subarray(-12);
  const badChecksum = Buffer.from(png);
  badChecksum[badChecksum.length - 15] ^= 1;
  const nonAsciiHeader = Buffer.from(header);
  nonAsciiHeader[4] |= 128;
  nonAsciiHeader.writeUInt32BE(crc32(nonAsciiHeader.subarray(4, -4)), nonAsciiHeader.length - 4);
  const unknown = pngChunk('ZZZZ', Buffer.from([1]));
  for (const bytes of [
    Buffer.concat([signature, pngChunk('tEXt', Buffer.from([0, 0, 0, 1, 0, 0, 0, 1])), end]),
    Buffer.concat([signature, header, end]),
    Buffer.concat([signature, nonAsciiHeader, data, end]),
    Buffer.concat([signature, header, header, data, end]),
    Buffer.concat([signature, header, unknown, data, end]),
    Buffer.concat([signature, header, data, pngChunk('tEXt', Buffer.from('fixture')), data, end]),
    Buffer.concat([
      signature,
      header,
      pngChunk('IDAT', Buffer.alloc(0)),
      pngChunk('tEXt', Buffer.from('fixture')),
      data,
      end,
    ]),
    Buffer.concat([signature, header, pngChunk('acTL', Buffer.alloc(8)), data, end]),
    badChecksum,
    png.subarray(0, -1),
    Buffer.concat([png, Buffer.from('<html>unexpected</html>')]),
  ])
    assert.equal(rasterImageType(bytes), null);
});

test('JPEG rejects header-only data, truncated scans and payloads after EOI', () => {
  const start = jpeg.indexOf(Buffer.from([255, 192]));
  const scan = jpeg.indexOf(Buffer.from([255, 218]));
  const headerEnd = scan + 2 + jpeg.readUInt16BE(scan + 2);
  for (const bytes of [
    jpeg.subarray(0, start + 2 + jpeg.readUInt16BE(start + 2)),
    jpeg.subarray(0, -2),
    Buffer.concat([jpeg.subarray(0, scan), Buffer.from([255, 217])]),
    Buffer.concat([jpeg.subarray(0, headerEnd), Buffer.from([255, 217])]),
    Buffer.concat([jpeg, Buffer.from('<html>unexpected</html>')]),
    Buffer.from([255, 216, 255, 255, 255]),
  ])
    assert.equal(rasterImageType(bytes), null);
  const stuffed = Buffer.concat([
    jpeg.subarray(0, -2),
    Buffer.from([255, 0, 255, 208]),
    jpeg.subarray(-2),
  ]);
  assert.equal(rasterImageType(stuffed), 'image/jpeg');
});

test('WebP rejects mismatched RIFF sizes, missing payloads, animation and overflowing chunks', () => {
  const extended = Buffer.alloc(10);
  extended.writeUIntLE(3, 4, 3);
  extended.writeUIntLE(3, 7, 3);
  const animated = Buffer.from(extended);
  animated[0] = 2;
  const badLength = Buffer.from(webp);
  badLength.writeUInt32LE(0xffffffff, 16);
  const truncated = Buffer.from(webp.subarray(0, 30));
  truncated.writeUInt32LE(truncated.length - 8, 4);
  truncated.writeUInt32LE(10, 16);
  const mismatch = Buffer.from(extended);
  mismatch.writeUIntLE(5, 4, 3);
  for (const bytes of [
    Buffer.concat([webp, Buffer.from('payload')]),
    webp.subarray(0, -1),
    badLength,
    truncated,
    riff(webpChunk('VP8X', extended)),
    riff(webpChunk('VP8X', animated), webp.subarray(12)),
    riff(webpChunk('VP8X', extended), webpChunk('ANMF', Buffer.alloc(16)), webp.subarray(12)),
    riff(webpChunk('VP8X', mismatch), webp.subarray(12)),
    riff(webpChunk('VP8X', extended), webp.subarray(12), webp.subarray(12)),
    riff(webpChunk('VP8L', Buffer.from([47, 0, 0, 0, 0]))),
  ])
    assert.equal(rasterImageType(bytes), null);
});
