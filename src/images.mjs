// Reads an image's type and size from its first bytes, so the page can reserve the right space
// before the picture loads and nothing jumps. No dependencies.

export const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
  // Short screen recordings play in the same viewer.
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
}
export const isVideo = (src) => /\.(mp4|webm)$/i.test(src)

// Returns [width, height] or null when the size cannot be read (the page then simply does not reserve space).
export function imageSize(buf) {
  if (!buf || buf.length < 24) return null
  // PNG: width and height sit in the IHDR chunk
  if (buf.readUInt32BE(0) === 0x89504e47) return [buf.readUInt32BE(16), buf.readUInt32BE(20)]
  // GIF: little-endian, right after the header
  if (buf.toString('ascii', 0, 3) === 'GIF') return [buf.readUInt16LE(6), buf.readUInt16LE(8)]
  // JPEG: walk the markers until a start-of-frame
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue }
      const m = buf[i + 1]
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return [buf.readUInt16BE(i + 7), buf.readUInt16BE(i + 5)]
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue }
      i += 2 + buf.readUInt16BE(i + 2)
    }
    return null
  }
  // WebP: three flavours
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const kind = buf.toString('ascii', 12, 16)
    if (kind === 'VP8 ') return [buf.readUInt16LE(26) & 0x3fff, buf.readUInt16LE(28) & 0x3fff]
    if (kind === 'VP8L') {
      const b = buf.readUInt32LE(21)
      return [(b & 0x3fff) + 1, ((b >> 14) & 0x3fff) + 1]
    }
    if (kind === 'VP8X') return [1 + buf.readUIntLE(24, 3), 1 + buf.readUIntLE(27, 3)]
  }
  return null
}
