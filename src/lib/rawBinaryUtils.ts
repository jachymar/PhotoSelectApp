/**
 * Pure, DOM-free binary RAW / TIFF / Canon CR3 / JPEG EXIF utilities.
 * Shared between the main thread (`rawParser.ts`) and the dedicated
 * background preview decode Web Worker (`previewDecodeWorker.ts`).
 */

export interface ParsedExif {
  make?: string;
  model?: string;
  lens?: string;
  iso?: number;
  aperture?: number;
  exposureTime?: number;
  focalLength?: number;
  dateTaken?: string;
  orientation?: number;
}

export interface BinaryTiffMetadata {
  make?: string;
  model?: string;
  lens?: string;
  iso?: number;
  aperture?: number;
  exposureTime?: number;
  focalLength?: number;
  orientation?: number;
  dateTimeOriginal?: string;
  createDate?: string;
  modifyDate?: string;
  subSecTimeOriginal?: string;
  subSecTime?: string;
}

export interface Cr3BoxParseResult {
  prvwJpeg?: Uint8Array;
  thmbJpeg?: Uint8Array;
  cmt1?: Uint8Array;
  cmt2?: Uint8Array;
  prvwBoxRange?: { start: number; end: number };
}

const TIFF_TYPE_SIZES: Record<number, number> = {
  1: 1, // BYTE
  2: 1, // ASCII
  3: 2, // SHORT
  4: 4, // LONG
  5: 8, // RATIONAL
  6: 1, // SBYTE
  7: 1, // UNDEFINED
  8: 2, // SSHORT
  9: 4, // SLONG
  10: 8, // SRATIONAL
};

/**
 * Ultra-fast synchronous binary TIFF / Exif IFD reader (< 0.05 ms).
 * Supports Little-Endian ("II") and Big-Endian ("MM") TIFF headers, Canon CR3 CMT1 & CMT2
 * (where CMT2 root IFD directly holds ExifIFD tags without an 0x8769 pointer),
 * standard TIFF-based RAWs (CR2, NEF, ARW, DNG, PEF, ORF, RW2), and Fujifilm RAF headers.
 */
export function parseTiffIfdMetadata(
  bytes: Uint8Array,
  initialOffset = 0
): BinaryTiffMetadata | undefined {
  const len = bytes.byteLength;
  if (len < initialOffset + 16) return undefined;

  const tiffStart = initialOffset;

  // Fujifilm RAF header: "FUJIFILMCCD-RAW " -> embedded JPEG offset at bytes 84..87 (big-endian)
  if (
    tiffStart === 0 &&
    len >= 92 &&
    bytes[0] === 0x46 && // 'F'
    bytes[1] === 0x55 && // 'U'
    bytes[2] === 0x4a && // 'J'
    bytes[3] === 0x49 // 'I'
  ) {
    const viewRaf = new DataView(
      bytes.buffer,
      bytes.byteOffset,
      bytes.byteLength
    );
    const jpegOff = viewRaf.getUint32(84, false);
    if (jpegOff > 0 && jpegOff + 24 < len) {
      return parseJpegApp1Metadata(bytes.subarray(jpegOff));
    }
    return undefined;
  }

  // If handed a JPEG buffer (FF D8), locate its APP1 Exif TIFF header
  if (bytes[tiffStart] === 0xff && bytes[tiffStart + 1] === 0xd8) {
    return parseJpegApp1Metadata(
      tiffStart === 0 ? bytes : bytes.subarray(tiffStart)
    );
  }

  const b0 = bytes[tiffStart];
  const b1 = bytes[tiffStart + 1];
  const littleEndian = b0 === 0x49 && b1 === 0x49;
  const bigEndian = b0 === 0x4d && b1 === 0x4d;
  if (!littleEndian && !bigEndian) {
    return undefined;
  }

  const view = new DataView(
    bytes.buffer,
    bytes.byteOffset + tiffStart,
    len - tiffStart
  );
  const tiffLen = view.byteLength;
  const magic = view.getUint16(2, littleEndian);
  // 0x002A = standard TIFF/CR2/NEF/ARW/DNG/CMT1/CMT2, 0x0055 = Panasonic RW2, 0x4F52 / 0x5352 = Olympus ORF
  if (
    magic !== 0x002a &&
    magic !== 0x0055 &&
    magic !== 0x4f52 &&
    magic !== 0x5352
  ) {
    return undefined;
  }

  const out: BinaryTiffMetadata = {};
  const visitedOffsets = new Set<number>();

  const readAscii = (valOffset: number, count: number): string | undefined => {
    if (count <= 0 || valOffset < 0 || valOffset + count > tiffLen) {
      return undefined;
    }
    let str = '';
    const maxChars = Math.min(count, 128);
    for (let i = 0; i < maxChars; i++) {
      const code = view.getUint8(valOffset + i);
      if (code === 0) break;
      if (code >= 32 && code <= 126) {
        str += String.fromCharCode(code);
      }
    }
    const trimmed = str.trim();
    return trimmed ? trimmed : undefined;
  };

  const readUnsignedInt = (
    type: number,
    entryOffset: number
  ): number | undefined => {
    if (type === 3) {
      return view.getUint16(entryOffset + 8, littleEndian);
    }
    if (type === 4) {
      return view.getUint32(entryOffset + 8, littleEndian);
    }
    if (type === 8) {
      return view.getInt16(entryOffset + 8, littleEndian);
    }
    if (type === 9) {
      return view.getInt32(entryOffset + 8, littleEndian);
    }
    return undefined;
  };

  const readRational = (
    type: number,
    valOffset: number
  ): number | undefined => {
    if (valOffset < 0 || valOffset + 8 > tiffLen) return undefined;
    if (type === 5) {
      const num = view.getUint32(valOffset, littleEndian);
      const den = view.getUint32(valOffset + 4, littleEndian);
      return den > 0 ? num / den : undefined;
    }
    if (type === 10) {
      const num = view.getInt32(valOffset, littleEndian);
      const den = view.getInt32(valOffset + 4, littleEndian);
      return den !== 0 ? num / den : undefined;
    }
    return undefined;
  };

  const parseIfdAt = (ifdOffset: number, depth: number) => {
    if (
      depth > 3 ||
      ifdOffset < 8 ||
      ifdOffset + 2 > tiffLen ||
      visitedOffsets.has(ifdOffset)
    ) {
      return;
    }
    visitedOffsets.add(ifdOffset);

    const entryCount = view.getUint16(ifdOffset, littleEndian);
    if (entryCount === 0 || entryCount > 512) return;

    const subIfdPointers: number[] = [];

    for (let i = 0; i < entryCount; i++) {
      const entryOff = ifdOffset + 2 + i * 12;
      if (entryOff + 12 > tiffLen) break;

      const tag = view.getUint16(entryOff, littleEndian);
      const type = view.getUint16(entryOff + 2, littleEndian);
      const count = view.getUint32(entryOff + 4, littleEndian);
      const unitSize = TIFF_TYPE_SIZES[type] || 1;
      const byteSize = count * unitSize;
      const valueOffset =
        byteSize <= 4
          ? entryOff + 8
          : view.getUint32(entryOff + 8, littleEndian);

      switch (tag) {
        case 0x010f: {
          if (!out.make) out.make = readAscii(valueOffset, count);
          break;
        }
        case 0x0110: {
          if (!out.model) out.model = readAscii(valueOffset, count);
          break;
        }
        case 0x0112: {
          if (out.orientation === undefined && depth === 0) {
            const o = readUnsignedInt(type, entryOff);
            if (o !== undefined && o >= 1 && o <= 8) {
              out.orientation = o;
            }
          }
          break;
        }
        case 0x0132: {
          if (!out.modifyDate) out.modifyDate = readAscii(valueOffset, count);
          break;
        }
        case 0x9003: {
          if (!out.dateTimeOriginal) {
            out.dateTimeOriginal = readAscii(valueOffset, count);
          }
          break;
        }
        case 0x9004: {
          if (!out.createDate) out.createDate = readAscii(valueOffset, count);
          break;
        }
        case 0x9291: {
          if (!out.subSecTimeOriginal) {
            out.subSecTimeOriginal = readAscii(valueOffset, count);
          }
          break;
        }
        case 0x9290: {
          if (!out.subSecTime) out.subSecTime = readAscii(valueOffset, count);
          break;
        }
        case 0x829a: {
          if (out.exposureTime === undefined) {
            const v = readRational(type, valueOffset);
            if (v !== undefined && v > 0) out.exposureTime = v;
          }
          break;
        }
        case 0x829d: {
          if (out.aperture === undefined) {
            const v = readRational(type, valueOffset);
            if (v !== undefined && v > 0) out.aperture = v;
          }
          break;
        }
        case 0x8827:
        case 0x8833: {
          if (out.iso === undefined) {
            const v =
              count === 1
                ? readUnsignedInt(type, entryOff)
                : valueOffset + 2 <= tiffLen
                  ? view.getUint16(valueOffset, littleEndian)
                  : undefined;
            if (v !== undefined && v > 0 && v < 10_000_000) {
              out.iso = v;
            }
          }
          break;
        }
        case 0x920a: {
          if (out.focalLength === undefined) {
            const v = readRational(type, valueOffset);
            if (v !== undefined && v > 0) out.focalLength = v;
          }
          break;
        }
        case 0xa434: {
          if (!out.lens) out.lens = readAscii(valueOffset, count);
          break;
        }
        case 0x8769: {
          const ptr = readUnsignedInt(type, entryOff);
          if (ptr !== undefined && ptr >= 8 && ptr < tiffLen) {
            subIfdPointers.push(ptr);
          }
          break;
        }
        default:
          break;
      }
    }

    for (const ptr of subIfdPointers) {
      parseIfdAt(ptr, depth + 1);
    }
  };

  const firstIfdOffset = view.getUint32(4, littleEndian);
  parseIfdAt(firstIfdOffset, 0);

  return Object.keys(out).length > 0 ? out : undefined;
}

export function parseJpegApp1Metadata(
  jpegBytes: Uint8Array
): BinaryTiffMetadata | undefined {
  const len = jpegBytes.byteLength;
  if (len < 14 || jpegBytes[0] !== 0xff || jpegBytes[1] !== 0xd8) {
    return undefined;
  }
  let pos = 2;
  while (pos + 4 < len) {
    if (jpegBytes[pos] !== 0xff) break;
    while (pos < len && jpegBytes[pos] === 0xff) pos++;
    if (pos >= len) break;
    const marker = jpegBytes[pos++];
    if (marker === 0xd9 || marker === 0xda) break;
    if (
      marker === 0x00 ||
      marker === 0x01 ||
      (marker >= 0xd0 && marker <= 0xd8)
    ) {
      continue;
    }
    if (pos + 2 > len) break;
    const segLen = (jpegBytes[pos] << 8) | jpegBytes[pos + 1];
    if (segLen < 2 || pos + segLen > len) break;

    if (
      marker === 0xe1 &&
      segLen >= 14 &&
      jpegBytes[pos + 2] === 0x45 && // 'E'
      jpegBytes[pos + 3] === 0x78 && // 'x'
      jpegBytes[pos + 4] === 0x69 && // 'i'
      jpegBytes[pos + 5] === 0x66 && // 'f'
      jpegBytes[pos + 6] === 0x00 &&
      jpegBytes[pos + 7] === 0x00
    ) {
      return parseTiffIfdMetadata(
        jpegBytes.subarray(pos + 8, pos + segLen),
        0
      );
    }

    pos += segLen;
  }
  return undefined;
}

export function parseExifDateStringToTimestamp(
  dateStr?: string,
  subSecStr?: string
): { ms: number; label: string; dateOnlyLabel: string } | null {
  if (!dateStr) return null;
  const match = dateStr
    .trim()
    .match(/^(\d{4})[:\-/](\d{2})[:\-/](\d{2})\s+(\d{2}):(\d{2}):(\d{2})/);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (year < 1970 || month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }

  const subDigits = subSecStr ? subSecStr.replace(/\D/g, '').slice(0, 3) : '';
  const subMs = subDigits ? Number(subDigits.padEnd(3, '0')) || 0 : 0;

  const dt = new Date(year, month - 1, day, hour, minute, second, subMs);
  const ms = dt.getTime();
  if (Number.isNaN(ms)) return null;

  return {
    ms,
    label: dt.toLocaleString('cs-CZ', {
      day: 'numeric',
      month: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }),
    dateOnlyLabel: dt.toLocaleDateString('cs-CZ', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    }),
  };
}

export function binaryMetaToParsedExif(
  primary?: BinaryTiffMetadata,
  secondary?: BinaryTiffMetadata
): ParsedExif | undefined {
  if (!primary && !secondary) return undefined;
  const dateRaw =
    primary?.dateTimeOriginal ||
    secondary?.dateTimeOriginal ||
    primary?.createDate ||
    secondary?.createDate ||
    primary?.modifyDate ||
    secondary?.modifyDate;
  const parsedDate = parseExifDateStringToTimestamp(
    dateRaw,
    primary?.subSecTimeOriginal || secondary?.subSecTimeOriginal
  );

  const out: ParsedExif = {
    make: primary?.make || secondary?.make,
    model: primary?.model || secondary?.model,
    lens: primary?.lens || secondary?.lens,
    iso: primary?.iso ?? secondary?.iso,
    aperture: primary?.aperture ?? secondary?.aperture,
    exposureTime: primary?.exposureTime ?? secondary?.exposureTime,
    focalLength: primary?.focalLength ?? secondary?.focalLength,
    dateTaken: parsedDate?.dateOnlyLabel,
    orientation: primary?.orientation ?? secondary?.orientation,
  };
  return Object.values(out).some((v) => v !== undefined) ? out : undefined;
}

/**
 * Ensures an extracted RAW preview/thumbnail JPEG carries the camera's true EXIF Orientation
 * (`outerOrientation` in 2..8) without re-compressing pixels and without double-rotating JPEGs
 * that already contain the matching EXIF Orientation tag.
 */
export function ensureJpegExifOrientation(
  jpegBytes: Uint8Array,
  outerOrientation?: number
): Uint8Array<ArrayBuffer> {
  const len = jpegBytes.byteLength;
  if (
    !outerOrientation ||
    outerOrientation <= 1 ||
    outerOrientation > 8 ||
    len < 4 ||
    jpegBytes[0] !== 0xff ||
    jpegBytes[1] !== 0xd8
  ) {
    const copy = new Uint8Array(len);
    copy.set(jpegBytes);
    return copy;
  }

  let existingExifPayloadStart = -1;
  let existingOrientationValuePos = -1;
  let existingOrientationLittleEndian = true;
  let existingOrientationVal: number | undefined;

  let pos = 2;
  while (pos + 4 < len) {
    if (jpegBytes[pos] !== 0xff) break;
    while (pos < len && jpegBytes[pos] === 0xff) pos++;
    if (pos >= len) break;
    const marker = jpegBytes[pos++];
    if (marker === 0xd9 || marker === 0xda) break;
    if (
      marker === 0x00 ||
      marker === 0x01 ||
      (marker >= 0xd0 && marker <= 0xd8)
    ) {
      continue;
    }
    if (pos + 2 > len) break;
    const segLen = (jpegBytes[pos] << 8) | jpegBytes[pos + 1];
    if (segLen < 2 || pos + segLen > len) break;

    if (
      marker === 0xe1 &&
      segLen >= 16 &&
      jpegBytes[pos + 2] === 0x45 && // 'E'
      jpegBytes[pos + 3] === 0x78 && // 'x'
      jpegBytes[pos + 4] === 0x69 && // 'i'
      jpegBytes[pos + 5] === 0x66 && // 'f'
      jpegBytes[pos + 6] === 0x00 &&
      jpegBytes[pos + 7] === 0x00
    ) {
      existingExifPayloadStart = pos + 2;
      const tiffStart = pos + 8;
      const tiffEnd = pos + segLen;
      if (tiffStart + 10 <= tiffEnd) {
        const le =
          jpegBytes[tiffStart] === 0x49 && jpegBytes[tiffStart + 1] === 0x49;
        const be =
          jpegBytes[tiffStart] === 0x4d && jpegBytes[tiffStart + 1] === 0x4d;
        if (le || be) {
          const dv = new DataView(
            jpegBytes.buffer,
            jpegBytes.byteOffset + tiffStart,
            tiffEnd - tiffStart
          );
          const magic = dv.getUint16(2, le);
          if (magic === 0x002a) {
            const ifd0 = dv.getUint32(4, le);
            if (ifd0 >= 8 && ifd0 + 2 <= dv.byteLength) {
              const count = dv.getUint16(ifd0, le);
              for (let i = 0; i < count && i < 256; i++) {
                const eOff = ifd0 + 2 + i * 12;
                if (eOff + 12 > dv.byteLength) break;
                const tag = dv.getUint16(eOff, le);
                const type = dv.getUint16(eOff + 2, le);
                if (tag === 0x0112 && type === 3) {
                  existingOrientationVal = dv.getUint16(eOff + 8, le);
                  existingOrientationValuePos = tiffStart + eOff + 8;
                  existingOrientationLittleEndian = le;
                  break;
                }
              }
            }
          }
        }
      }
      break;
    }

    pos += segLen;
  }

  if (existingOrientationVal === outerOrientation) {
    const copy = new Uint8Array(len);
    copy.set(jpegBytes);
    return copy;
  }

  if (existingOrientationValuePos >= 0) {
    const patched = new Uint8Array(len);
    patched.set(jpegBytes);
    if (existingOrientationLittleEndian) {
      patched[existingOrientationValuePos] = outerOrientation & 0xff;
      patched[existingOrientationValuePos + 1] = 0x00;
    } else {
      patched[existingOrientationValuePos] = 0x00;
      patched[existingOrientationValuePos + 1] = outerOrientation & 0xff;
    }
    return patched;
  }

  const app1Segment = new Uint8Array([
    0xff,
    0xe1, // APP1 marker
    0x00,
    0x22, // Length = 34 bytes (2 + 6 + 26)
    0x45,
    0x78,
    0x69,
    0x66,
    0x00,
    0x00, // "Exif\0\0"
    0x49,
    0x49, // "II" Little-Endian
    0x2a,
    0x00, // TIFF magic 42
    0x08,
    0x00,
    0x00,
    0x00, // Offset to IFD0 = 8
    0x01,
    0x00, // 1 IFD0 entry
    0x12,
    0x01, // Tag 0x0112 (Orientation)
    0x03,
    0x00, // Type 3 (SHORT)
    0x01,
    0x00,
    0x00,
    0x00, // Count = 1
    outerOrientation & 0xff,
    0x00,
    0x00,
    0x00, // SHORT value + padding
    0x00,
    0x00,
    0x00,
    0x00, // Next IFD = 0
  ]);

  const out = new Uint8Array(2 + app1Segment.byteLength + (len - 2));
  out[0] = 0xff;
  out[1] = 0xd8;
  out.set(app1Segment, 2);
  out.set(jpegBytes.subarray(2), 2 + app1Segment.byteLength);

  if (existingExifPayloadStart >= 2) {
    const shifted = existingExifPayloadStart + app1Segment.byteLength;
    if (shifted + 3 < out.byteLength) {
      out[shifted + 3] = 0x30; // "Exi0"
    }
  }

  return out;
}

/**
 * Finds the largest complete embedded JPEG inside a binary RAW buffer (CR3, CR2, NEF, ARW, DNG, ORF, RW2, RAF).
 * Walks JPEG segments accurately up to SOS (0xFFDA) so nested EXIF APP1 thumbnails' FFD9 markers
 * never cause premature truncation.
 */
export function extractLargestEmbeddedJpeg(
  buffer: ArrayBuffer,
  options: { minBytes?: number; startOffset?: number } = {}
): Uint8Array | null {
  const bytes = new Uint8Array(buffer);
  const len = bytes.length;
  const minBytes = options.minBytes ?? 4096;
  let bestStart = -1;
  let bestEnd = -1;
  let bestSize = 0;

  let i = Math.max(0, options.startOffset ?? 0);
  while (i < len - 10) {
    const m3 = bytes[i + 3];
    if (
      bytes[i] === 0xff &&
      bytes[i + 1] === 0xd8 &&
      bytes[i + 2] === 0xff &&
      ((m3 >= 0xc0 && m3 <= 0xfe) || m3 === 0xdd)
    ) {
      const start = i;
      let pos = i + 2;
      let reachedSos = false;
      let foundEnd = -1;

      while (pos + 3 < len) {
        if (bytes[pos] !== 0xff) {
          break;
        }
        while (pos < len && bytes[pos] === 0xff) {
          pos++;
        }
        if (pos >= len) break;

        const marker = bytes[pos];
        pos++;

        if (
          marker === 0x00 ||
          marker === 0x01 ||
          (marker >= 0xd0 && marker <= 0xd8)
        ) {
          continue;
        }
        if (marker === 0xd9) {
          foundEnd = pos;
          break;
        }
        if (marker === 0xda) {
          if (pos + 1 >= len) break;
          const sosLen = (bytes[pos] << 8) | bytes[pos + 1];
          pos += sosLen;
          reachedSos = true;
          break;
        }

        if (pos + 1 >= len) break;
        const segLen = (bytes[pos] << 8) | bytes[pos + 1];
        if (segLen < 2 || pos + segLen > len) {
          break;
        }
        pos += segLen;
      }

      if (reachedSos) {
        while (pos + 1 < len) {
          if (bytes[pos] === 0xff) {
            const next = bytes[pos + 1];
            if (next === 0xd9) {
              foundEnd = pos + 2;
              break;
            }
            if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
              pos += 2;
              continue;
            }
            if (next === 0xff) {
              pos++;
              continue;
            }
          }
          pos++;
        }
      }

      if (foundEnd > start) {
        const size = foundEnd - start;
        if (size > bestSize) {
          bestSize = size;
          bestStart = start;
          bestEnd = foundEnd;
        }
        i = foundEnd;
        continue;
      }
    }
    i++;
  }

  if (bestStart !== -1 && bestSize > minBytes) {
    return bytes.subarray(bestStart, bestEnd);
  }
  return null;
}

/**
 * Searches Canon CR3 ISOBMFF boxes for PRVW, THMB, CMT1 (IFD0 + Orientation), and CMT2 (ExifIFD + SubSecTimeOriginal).
 */
export function findCanonPrvwOrExifInCr3(buffer: ArrayBuffer): Cr3BoxParseResult {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const len = bytes.length;
  let cmt1: Uint8Array | undefined;
  let cmt2: Uint8Array | undefined;
  let prvwJpeg: Uint8Array | undefined;
  let thmbJpeg: Uint8Array | undefined;
  let prvwBoxRange: { start: number; end: number } | undefined;

  const readType = (offset: number) =>
    String.fromCharCode(
      bytes[offset],
      bytes[offset + 1],
      bytes[offset + 2],
      bytes[offset + 3]
    );

  const isCanonPrvwUuid = (uuidOffset: number): boolean =>
    uuidOffset + 16 <= len &&
    bytes[uuidOffset] === 0xea &&
    bytes[uuidOffset + 1] === 0xf4 &&
    bytes[uuidOffset + 2] === 0x2b &&
    bytes[uuidOffset + 3] === 0x5e;

  const walkBoxes = (start: number, end: number, depth = 0) => {
    if (depth > 7) return;
    let offset = start;
    while (offset + 8 <= end) {
      let boxSize = view.getUint32(offset, false);
      const boxType = readType(offset + 4);
      let headerSize = 8;

      if (boxSize === 1) {
        if (offset + 16 > end) break;
        const hi = view.getUint32(offset + 8, false);
        const lo = view.getUint32(offset + 12, false);
        boxSize = hi * 4294967296 + lo;
        headerSize = 16;
      } else if (boxSize === 0) {
        boxSize = end - offset;
      }

      if (boxSize < headerSize) {
        break;
      }

      const contentStart = offset + headerSize;
      const contentEnd = offset + boxSize;
      const clampedEnd = Math.min(contentEnd, end);

      if (
        boxType === 'moov' ||
        boxType === 'trak' ||
        boxType === 'mdia' ||
        boxType === 'minf' ||
        boxType === 'stbl' ||
        boxType === 'CNTH'
      ) {
        if (contentStart < clampedEnd) {
          walkBoxes(contentStart, clampedEnd, depth + 1);
        }
      } else if (boxType === 'uuid' && contentStart + 16 <= clampedEnd) {
        if (isCanonPrvwUuid(contentStart)) {
          prvwBoxRange = { start: offset, end: contentEnd };
        }
        if (contentStart + 16 < clampedEnd) {
          walkBoxes(contentStart + 16, clampedEnd, depth + 1);
        }
      } else if (boxType === 'CMT1' && contentEnd <= end) {
        cmt1 = bytes.subarray(contentStart, contentEnd);
      } else if (boxType === 'CMT2' && contentEnd <= end) {
        cmt2 = bytes.subarray(contentStart, contentEnd);
      } else if (
        boxType === 'THMB' &&
        contentEnd <= end &&
        contentStart + 16 < contentEnd
      ) {
        const cand = extractLargestEmbeddedJpeg(
          buffer.slice(contentStart, contentEnd),
          { minBytes: 512 }
        );
        if (cand && (!thmbJpeg || cand.byteLength > thmbJpeg.byteLength)) {
          thmbJpeg = cand;
        }
      } else if (boxType === 'PRVW') {
        prvwBoxRange = { start: offset, end: contentEnd };
        if (contentEnd <= end && contentStart + 16 < contentEnd) {
          const jpegCandidate = extractLargestEmbeddedJpeg(
            buffer.slice(contentStart, contentEnd),
            { minBytes: 2048 }
          );
          if (
            jpegCandidate &&
            (!prvwJpeg || jpegCandidate.byteLength > prvwJpeg.byteLength)
          ) {
            prvwJpeg = jpegCandidate;
          }
        }
      }

      if (contentEnd > end) {
        break;
      }
      offset = contentEnd;
    }
  };

  if (
    len >= 12 &&
    (readType(4) === 'ftyp' || readType(4) === 'uuid' || readType(4) === 'PRVW')
  ) {
    walkBoxes(0, len, 0);
  }

  return { prvwJpeg, thmbJpeg, cmt1, cmt2, prvwBoxRange };
}
