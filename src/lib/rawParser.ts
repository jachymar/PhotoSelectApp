import exifr from 'exifr';
import { DrivePhotoFile, fetchDriveFileBytes } from './driveApi';
import { readLocalFileBytes } from './localMedia';

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

export interface ResolvedPhotoMedia {
  url: string;
  source: 'raw-embedded' | 'drive-media' | 'drive-thumbnail' | 'local-media';
  exif?: ParsedExif;
  isObjectUrl: boolean;
}

export async function fetchPhotoBytes(
  token: string | null | undefined,
  file: DrivePhotoFile,
  range?: { start: number; end: number },
  signal?: AbortSignal
): Promise<ArrayBuffer> {
  if (file.sourceKind && file.sourceKind !== 'drive') {
    return await readLocalFileBytes(file, range, signal);
  }
  if (!token) {
    throw new Error('Chybí přístupový token ke Google Drive.');
  }
  return await fetchDriveFileBytes(token, file.id, range, signal);
}

/**
 * Safely computes a byte range `{ start: 0, end }` even when an Android SAF / OTG provider
 * reports `sizeBytes === 0` during directory enumeration.
 */
function getHeaderRange(
  file: DrivePhotoFile,
  maxBytes: number
): { start: number; end: number } | undefined {
  if (file.sizeBytes > 0 && file.sizeBytes <= maxBytes) {
    return undefined;
  }
  const effectiveEnd =
    file.sizeBytes > 0
      ? Math.min(file.sizeBytes - 1, maxBytes - 1)
      : maxBytes - 1;
  return { start: 0, end: Math.max(0, effectiveEnd) };
}

interface BinaryTiffMetadata {
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
function parseTiffIfdMetadata(
  bytes: Uint8Array,
  initialOffset = 0
): BinaryTiffMetadata | undefined {
  const len = bytes.byteLength;
  if (len < initialOffset + 16) return undefined;

  let tiffStart = initialOffset;

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
        byteSize <= 4 ? entryOff + 8 : view.getUint32(entryOff + 8, littleEndian);

      switch (tag) {
        case 0x010f: {
          // Make
          if (!out.make) out.make = readAscii(valueOffset, count);
          break;
        }
        case 0x0110: {
          // Model
          if (!out.model) out.model = readAscii(valueOffset, count);
          break;
        }
        case 0x0112: {
          // Orientation (keep first IFD0 orientation)
          if (out.orientation === undefined && depth === 0) {
            const o = readUnsignedInt(type, entryOff);
            if (o !== undefined && o >= 1 && o <= 8) {
              out.orientation = o;
            }
          }
          break;
        }
        case 0x0132: {
          // ModifyDate
          if (!out.modifyDate) out.modifyDate = readAscii(valueOffset, count);
          break;
        }
        case 0x9003: {
          // DateTimeOriginal
          if (!out.dateTimeOriginal) {
            out.dateTimeOriginal = readAscii(valueOffset, count);
          }
          break;
        }
        case 0x9004: {
          // CreateDate
          if (!out.createDate) out.createDate = readAscii(valueOffset, count);
          break;
        }
        case 0x9291: {
          // SubSecTimeOriginal
          if (!out.subSecTimeOriginal) {
            out.subSecTimeOriginal = readAscii(valueOffset, count);
          }
          break;
        }
        case 0x9290: {
          // SubSecTime
          if (!out.subSecTime) out.subSecTime = readAscii(valueOffset, count);
          break;
        }
        case 0x829a: {
          // ExposureTime
          if (out.exposureTime === undefined) {
            const v = readRational(type, valueOffset);
            if (v !== undefined && v > 0) out.exposureTime = v;
          }
          break;
        }
        case 0x829d: {
          // FNumber
          if (out.aperture === undefined) {
            const v = readRational(type, valueOffset);
            if (v !== undefined && v > 0) out.aperture = v;
          }
          break;
        }
        case 0x8827:
        case 0x8833: {
          // ISO / PhotographicSensitivity / StandardOutputSensitivity
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
          // FocalLength
          if (out.focalLength === undefined) {
            const v = readRational(type, valueOffset);
            if (v !== undefined && v > 0) out.focalLength = v;
          }
          break;
        }
        case 0xa434: {
          // LensModel
          if (!out.lens) out.lens = readAscii(valueOffset, count);
          break;
        }
        case 0x8769: {
          // ExifIFD pointer
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

function parseJpegApp1Metadata(
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
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
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

function parseExifDateStringToTimestamp(
  dateStr?: string,
  subSecStr?: string
): { ms: number; label: string; dateOnlyLabel: string } | null {
  if (!dateStr) return null;
  // Standard EXIF format: "YYYY:MM:DD HH:MM:SS" or ISO-like
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

function binaryMetaToParsedExif(
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

  // Inspect existing JPEG segments up to SOS (0xFFDA) for an Exif APP1 segment
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
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
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

  // Case 1: Embedded JPEG already carries the exact non-1 camera orientation -> leave untouched
  if (existingOrientationVal === outerOrientation) {
    const copy = new Uint8Array(len);
    copy.set(jpegBytes);
    return copy;
  }

  // Case 2: Embedded JPEG has an Exif APP1 IFD0 Orientation tag (typically 1) -> patch 2 bytes in-place
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

  // Case 3: Embedded JPEG has NO Exif Orientation tag (e.g. Canon CR3 PRVW & THMB) ->
  // Prepend a minimal 36-byte EXIF APP1 segment immediately after SOI (FF D8).
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

  // Neutralize any incomplete secondary Exif header without 0x0112 so decoders strictly honor the primary APP1
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
    // JPEG SOI marker: FF D8 followed by FF and a valid JPEG segment/frame marker
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

      // Walk JPEG marker segments cleanly until Start Of Scan (0xFF 0xDA)
      while (pos + 3 < len) {
        if (bytes[pos] !== 0xff) {
          break;
        }
        // Skip fill 0xFF bytes
        while (pos < len && bytes[pos] === 0xff) {
          pos++;
        }
        if (pos >= len) break;

        const marker = bytes[pos];
        pos++;

        // Standalone markers (RST0..RST7, TEM, SOI)
        if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
          continue;
        }
        // EOI before SOS (invalid / tiny stub)
        if (marker === 0xd9) {
          foundEnd = pos;
          break;
        }
        // Start of Scan
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
        // Scan entropy-coded data for EOI (0xFF 0xD9)
        while (pos + 1 < len) {
          if (bytes[pos] === 0xff) {
            const next = bytes[pos + 1];
            if (next === 0xd9) {
              foundEnd = pos + 2;
              break;
            }
            // Byte stuffing (FF 00) or RST markers (FF D0..D7)
            if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
              pos += 2;
              continue;
            }
            // Another marker inside entropy stream (rare DNL etc.)
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

interface Cr3BoxParseResult {
  prvwJpeg?: Uint8Array;
  thmbJpeg?: Uint8Array;
  cmt1?: Uint8Array;
  cmt2?: Uint8Array;
  prvwBoxRange?: { start: number; end: number };
}

/**
 * Searches Canon CR3 ISOBMFF boxes for PRVW, THMB, CMT1 (IFD0 + Orientation), and CMT2 (ExifIFD + SubSecTimeOriginal).
 * Crucially clamps container boxes (`moov`, `uuid`, `CNTH`, `trak`, `mdia`) to `Math.min(contentEnd, end)`
 * so partial header slices (e.g. 256 KB or 4 MB) still descend into `moov` and extract `CMT1`, `CMT2`, `THMB`,
 * and record the exact byte range of truncated `uuid(eaf42b5e...)` / `PRVW` boxes!
 */
function findCanonPrvwOrExifInCr3(buffer: ArrayBuffer): Cr3BoxParseResult {
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
      } else if (boxType === 'THMB' && contentEnd <= end && contentStart + 16 < contentEnd) {
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

  if (len >= 12 && (readType(4) === 'ftyp' || readType(4) === 'uuid' || readType(4) === 'PRVW')) {
    walkBoxes(0, len, 0);
  }

  return { prvwJpeg, thmbJpeg, cmt1, cmt2, prvwBoxRange };
}

/**
 * Walks top-level ISOBMFF 16-byte box headers of a large Canon CR3 file using tiny 32-byte reads
 * to locate the exact `{ start, end }` of Canon's `uuid(eaf42b5e...)` preview container without ever reading `mdat`.
 */
async function locateCanonCr3PrvwBoxRange(
  token: string | null | undefined,
  file: DrivePhotoFile,
  signal?: AbortSignal
): Promise<{ start: number; end: number } | null> {
  let offset = 0;
  for (let step = 0; step < 12; step++) {
    if (signal?.aborted) return null;
    if (file.sizeBytes > 0 && offset + 16 >= file.sizeBytes) break;

    const headerBuf = await fetchPhotoBytes(
      token,
      file,
      { start: offset, end: offset + 31 },
      signal
    ).catch(() => null);
    if (!headerBuf || headerBuf.byteLength < 8) break;

    const dv = new DataView(headerBuf);
    const bytes = new Uint8Array(headerBuf);
    let boxSize = dv.getUint32(0, false);
    const boxType = String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7]);
    let headerSize = 8;

    if (boxSize === 1) {
      if (headerBuf.byteLength < 16) break;
      boxSize = dv.getUint32(8, false) * 4294967296 + dv.getUint32(12, false);
      headerSize = 16;
    }
    if (boxSize < headerSize) break;

    if (
      boxType === 'uuid' &&
      headerBuf.byteLength >= headerSize + 4 &&
      bytes[headerSize] === 0xea &&
      bytes[headerSize + 1] === 0xf4 &&
      bytes[headerSize + 2] === 0x2b &&
      bytes[headerSize + 3] === 0x5e
    ) {
      return { start: offset, end: offset + boxSize };
    }

    offset += boxSize;
  }
  return null;
}

const orientationHintCache = new Map<string, number>();

function rememberOrientationHint(fileId: string, orientation?: number) {
  if (orientation && orientation >= 1 && orientation <= 8) {
    orientationHintCache.set(fileId, orientation);
    if (orientationHintCache.size > 2000) {
      const oldest = orientationHintCache.keys().next().value;
      if (oldest) orientationHintCache.delete(oldest);
    }
  }
}

async function parseExifSafe(
  input: ArrayBuffer | Uint8Array
): Promise<ParsedExif | undefined> {
  const bytes =
    input instanceof Uint8Array
      ? input
      : new Uint8Array(input, 0, input.byteLength);

  // Fast binary TIFF/JPEG reader first
  const fastMeta = parseTiffIfdMetadata(bytes, 0);
  const fastParsed = binaryMetaToParsedExif(fastMeta);

  try {
    const data = await exifr.parse(input, {
      tiff: true,
      exif: true,
    });
    if (!data) return fastParsed;
    return {
      make: data.Make ? String(data.Make).trim() : fastParsed?.make,
      model: data.Model ? String(data.Model).trim() : fastParsed?.model,
      lens: data.LensModel ? String(data.LensModel).trim() : fastParsed?.lens,
      iso: typeof data.ISO === 'number' ? data.ISO : fastParsed?.iso,
      aperture:
        typeof data.FNumber === 'number' ? data.FNumber : fastParsed?.aperture,
      exposureTime:
        typeof data.ExposureTime === 'number'
          ? data.ExposureTime
          : fastParsed?.exposureTime,
      focalLength:
        typeof data.FocalLength === 'number'
          ? data.FocalLength
          : fastParsed?.focalLength,
      dateTaken:
        data.DateTimeOriginal instanceof Date
          ? data.DateTimeOriginal.toLocaleDateString('cs-CZ', {
              day: 'numeric',
              month: 'short',
              year: 'numeric',
            })
          : fastParsed?.dateTaken,
      orientation:
        typeof data.Orientation === 'number'
          ? data.Orientation
          : fastParsed?.orientation,
    };
  } catch {
    return fastParsed;
  }
}

export async function extractExifTimestampFromHeader(
  token: string | null | undefined,
  file: DrivePhotoFile,
  signal?: AbortSignal
): Promise<{ ms: number; label: string } | null> {
  try {
    // 256 KB easily covers Canon CR3 ftyp + moov -> uuid -> CMT1 + CMT2 as well as all JPG/RAW TIFF headers
    const buffer = await fetchPhotoBytes(
      token,
      file,
      getHeaderRange(file, 262144),
      signal
    );
    const bytes = new Uint8Array(buffer);

    if (file.fileExtension === 'cr3') {
      const cr3 = findCanonPrvwOrExifInCr3(buffer);
      const meta1 = cr3.cmt1 ? parseTiffIfdMetadata(cr3.cmt1, 0) : undefined;
      const meta2 = cr3.cmt2 ? parseTiffIfdMetadata(cr3.cmt2, 0) : undefined;
      rememberOrientationHint(file.id, meta1?.orientation);

      const dateStr =
        meta2?.dateTimeOriginal ||
        meta2?.createDate ||
        meta1?.dateTimeOriginal ||
        meta1?.modifyDate;
      const subSecStr = meta2?.subSecTimeOriginal || meta2?.subSecTime;
      const ts = parseExifDateStringToTimestamp(dateStr, subSecStr);
      if (ts) {
        return { ms: ts.ms, label: ts.label };
      }
    } else {
      const fastMeta = parseTiffIfdMetadata(bytes, 0);
      rememberOrientationHint(file.id, fastMeta?.orientation);
      const dateStr =
        fastMeta?.dateTimeOriginal ||
        fastMeta?.createDate ||
        fastMeta?.modifyDate;
      const subSecStr = fastMeta?.subSecTimeOriginal || fastMeta?.subSecTime;
      const ts = parseExifDateStringToTimestamp(dateStr, subSecStr);
      if (ts) {
        return { ms: ts.ms, label: ts.label };
      }
    }

    // Fallback to exifr for uncommon container layouts (HEIC/AVIF/XMP)
    const parsed = await exifr.parse(buffer, { tiff: true, exif: true });
    if (typeof parsed?.Orientation === 'number') {
      rememberOrientationHint(file.id, parsed.Orientation);
    }
    let rawDate: Date | undefined;
    let subSecStr: string | undefined;
    if (parsed?.DateTimeOriginal instanceof Date) {
      rawDate = parsed.DateTimeOriginal;
      subSecStr = parsed.SubSecTimeOriginal
        ? String(parsed.SubSecTimeOriginal)
        : undefined;
    } else if (parsed?.CreateDate instanceof Date) {
      rawDate = parsed.CreateDate;
    }
    if (!rawDate || Number.isNaN(rawDate.getTime())) return null;

    const subMs = subSecStr
      ? Number(subSecStr.replace(/\D/g, '').slice(0, 3).padEnd(3, '0')) || 0
      : 0;
    const ms = rawDate.getTime() + subMs;
    const label = rawDate.toLocaleString('cs-CZ', {
      day: 'numeric',
      month: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    return { ms, label };
  } catch {
    return null;
  }
}

function mergeExifWithDrive(
  file: DrivePhotoFile,
  parsed?: ParsedExif
): ParsedExif | undefined {
  const merged: ParsedExif = {
    make: parsed?.make || file.cameraMake,
    model: parsed?.model || file.cameraModel,
    lens: parsed?.lens,
    iso: parsed?.iso ?? file.isoSpeed,
    aperture: parsed?.aperture ?? file.aperture,
    exposureTime: parsed?.exposureTime ?? file.exposureTime,
    focalLength: parsed?.focalLength ?? file.focalLength,
    dateTaken: parsed?.dateTaken,
    orientation: parsed?.orientation ?? orientationHintCache.get(file.id),
  };
  const hasAny = Object.values(merged).some((v) => v !== undefined);
  return hasAny ? merged : undefined;
}

const mediaCache = new Map<string, ResolvedPhotoMedia>();
const MAX_CACHE_SIZE = 28;

function setCacheEntry(key: string, value: ResolvedPhotoMedia) {
  if (mediaCache.has(key)) {
    const prev = mediaCache.get(key)!;
    if (prev.isObjectUrl && prev.url !== value.url) {
      URL.revokeObjectURL(prev.url);
    }
    mediaCache.delete(key);
  }
  mediaCache.set(key, value);
  if (mediaCache.size > MAX_CACHE_SIZE) {
    const oldestKey = mediaCache.keys().next().value;
    if (oldestKey) {
      const oldest = mediaCache.get(oldestKey);
      if (oldest?.isObjectUrl) {
        URL.revokeObjectURL(oldest.url);
      }
      mediaCache.delete(oldestKey);
    }
  }
}

interface FilmstripCacheEntry {
  url: string;
  isObjectUrl: boolean;
}

const filmstripCache = new Map<string, FilmstripCacheEntry>();
const MAX_FILMSTRIP_CACHE_SIZE = 520;

function setFilmstripCacheEntry(key: string, value: FilmstripCacheEntry) {
  if (filmstripCache.has(key)) {
    const prev = filmstripCache.get(key)!;
    if (prev.isObjectUrl && prev.url !== value.url) {
      URL.revokeObjectURL(prev.url);
    }
    filmstripCache.delete(key);
  }
  filmstripCache.set(key, value);
  if (filmstripCache.size > MAX_FILMSTRIP_CACHE_SIZE) {
    const oldestKey = filmstripCache.keys().next().value;
    if (oldestKey) {
      const oldest = filmstripCache.get(oldestKey);
      if (oldest?.isObjectUrl) {
        URL.revokeObjectURL(oldest.url);
      }
      filmstripCache.delete(oldestKey);
    }
  }
}

export function clearFilmstripCache() {
  for (const entry of filmstripCache.values()) {
    if (entry.isObjectUrl) {
      URL.revokeObjectURL(entry.url);
    }
  }
  filmstripCache.clear();
}

export function clearMediaCache() {
  for (const entry of mediaCache.values()) {
    if (entry.isObjectUrl) {
      URL.revokeObjectURL(entry.url);
    }
  }
  mediaCache.clear();
  clearFilmstripCache();
}

export function getCachedFilmstripThumbnailUrl(fileId: string): string | null {
  return filmstripCache.get(fileId)?.url || null;
}

export function getFilmstripThumbnailUrl(thumbnailLink?: string): string | null {
  if (!thumbnailLink) return null;
  if (/=s\d+$/.test(thumbnailLink)) {
    return thumbnailLink.replace(/=s\d+$/, '=s160');
  }
  return thumbnailLink;
}

export function getGalleryThumbnailUrl(
  thumbnailLink?: string,
  highDetail = false
): string | null {
  if (!thumbnailLink) return null;
  if (/=s\d+$/.test(thumbnailLink)) {
    return thumbnailLink.replace(/=s\d+$/, highDetail ? '=s360' : '=s220');
  }
  return thumbnailLink;
}

export function getFastPreviewThumbnailUrl(thumbnailLink?: string): string | null {
  if (!thumbnailLink) return null;
  if (/=s\d+$/.test(thumbnailLink)) {
    return thumbnailLink.replace(/=s\d+$/, '=s360');
  }
  return thumbnailLink;
}

export function getUpgradeThumbnailUrl(thumbnailLink?: string): string | null {
  if (!thumbnailLink) return null;
  if (/=s\d+$/.test(thumbnailLink)) {
    return thumbnailLink.replace(/=s\d+$/, '=s1600');
  }
  return thumbnailLink;
}

async function downscaleBlobToFilmstripUrl(
  blob: Blob,
  targetMaxDim = 200
): Promise<string> {
  if (typeof createImageBitmap !== 'function') {
    return URL.createObjectURL(blob);
  }
  let bitmap: ImageBitmap | null = null;
  try {
    // Decode without resizeWidth options first so all mobile WebViews honor EXIF Orientation (from-image)
    bitmap = await createImageBitmap(blob);
    const maxSide = Math.max(bitmap.width, bitmap.height);
    const ratio = maxSide > 0 ? Math.min(1, targetMaxDim / maxSide) : 1;
    const w = Math.max(1, Math.round(bitmap.width * ratio));
    const h = Math.max(1, Math.round(bitmap.height * ratio));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return URL.createObjectURL(blob);
    }
    ctx.drawImage(bitmap, 0, 0, w, h);
    const outBlob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.75)
    );
    if (!outBlob) {
      return URL.createObjectURL(blob);
    }
    return URL.createObjectURL(outBlob);
  } catch {
    return URL.createObjectURL(blob);
  } finally {
    bitmap?.close();
  }
}

export async function resolveFilmstripThumbnailUrl(
  token: string | null | undefined,
  file: DrivePhotoFile,
  signal?: AbortSignal
): Promise<string | null> {
  if (signal?.aborted) return null;
  const cached = filmstripCache.get(file.id);
  if (cached) {
    filmstripCache.delete(file.id);
    filmstripCache.set(file.id, cached);
    return cached.url;
  }

  const isLocal = Boolean(file.sourceKind && file.sourceKind !== 'drive');

  if (!isLocal && file.thumbnailLink) {
    const url = getFilmstripThumbnailUrl(file.thumbnailLink);
    if (url) {
      setFilmstripCacheEntry(file.id, { url, isObjectUrl: false });
      return url;
    }
  }

  // Only use Android SAF's OS getDocumentThumbnail for standard non-RAW images,
  // because Android ExternalStorageProvider returns sideways unrotated thumbnails for RAW/CR3 files.
  if (
    !file.isRaw &&
    file.sourceKind === 'android-saf' &&
    file.nativeUri &&
    window.FrameCullNative?.getThumbnailUrl
  ) {
    try {
      const nativeThumb = await window.FrameCullNative.getThumbnailUrl(
        file.nativeUri
      );
      if (signal?.aborted) return null;
      if (nativeThumb) {
        setFilmstripCacheEntry(file.id, {
          url: nativeThumb,
          isObjectUrl: nativeThumb.startsWith('blob:'),
        });
        return nativeThumb;
      }
    } catch {
      // Fall through to header/slice extraction
    }
  }

  if (isLocal && !file.isRaw) {
    const blobFile =
      file.localFile ||
      (file.fsHandle ? await file.fsHandle.getFile().catch(() => null) : null);
    if (blobFile) {
      if (signal?.aborted) return null;
      const headerThumb = await extractFastHeaderThumbnailBlob(
        token,
        file,
        signal
      ).catch(() => null);
      if (signal?.aborted) return null;
      const sourceBlob = headerThumb || blobFile;
      const url = await downscaleBlobToFilmstripUrl(sourceBlob, 200);
      if (signal?.aborted) {
        URL.revokeObjectURL(url);
        return null;
      }
      setFilmstripCacheEntry(file.id, { url, isObjectUrl: true });
      return url;
    }
  }

  const thumbBlob = await extractFastHeaderThumbnailBlob(
    token,
    file,
    signal
  ).catch(() => null);
  if (signal?.aborted) return null;
  if (!thumbBlob) {
    if (
      file.sourceKind === 'android-saf' &&
      !file.isRaw &&
      file.nativeUri &&
      window.FrameCullNative?.getFullMediaUrl
    ) {
      const fullUrl = await window.FrameCullNative
        .getFullMediaUrl(file.nativeUri)
        .catch(() => null);
      if (fullUrl && !signal?.aborted) {
        setFilmstripCacheEntry(file.id, {
          url: fullUrl,
          isObjectUrl: fullUrl.startsWith('blob:'),
        });
        return fullUrl;
      }
    }
    return null;
  }

  const url = await downscaleBlobToFilmstripUrl(thumbBlob, 200);
  if (signal?.aborted) {
    URL.revokeObjectURL(url);
    return null;
  }
  setFilmstripCacheEntry(file.id, { url, isObjectUrl: true });
  return url;
}

export function preloadImageUrl(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.referrerPolicy = 'no-referrer';
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('Image load failed'));
    img.src = url;
  });
}

function resolveRawHeaderOrientation(
  file: DrivePhotoFile,
  buffer: ArrayBuffer,
  cr3Cmt1?: Uint8Array
): number | undefined {
  if (cr3Cmt1) {
    const o = parseTiffIfdMetadata(cr3Cmt1, 0)?.orientation;
    if (o !== undefined) {
      rememberOrientationHint(file.id, o);
      return o;
    }
  }
  if (file.fileExtension !== 'cr3') {
    const o = parseTiffIfdMetadata(new Uint8Array(buffer), 0)?.orientation;
    if (o !== undefined) {
      rememberOrientationHint(file.id, o);
      return o;
    }
  }
  return orientationHintCache.get(file.id);
}

/**
 * Extracts a quick temporary low-res upright JPEG from the first 512 KB of a RAW/CR3 file.
 */
export async function resolveFastTempRawPreview(
  token: string | null | undefined,
  file: DrivePhotoFile,
  signal?: AbortSignal
): Promise<string | null> {
  if (!file.isRaw) return null;
  const cacheKey = `${file.id}:temp-raw`;
  const cached = mediaCache.get(cacheKey);
  if (cached) return cached.url;

  try {
    const buffer = await fetchPhotoBytes(
      token,
      file,
      getHeaderRange(file, 524288), // 512 KB
      signal
    );
    const cr3 =
      file.fileExtension === 'cr3' ? findCanonPrvwOrExifInCr3(buffer) : {};
    const outerOrientation = resolveRawHeaderOrientation(
      file,
      buffer,
      cr3.cmt1
    );
    const jpegBytes =
      cr3.prvwJpeg ||
      cr3.thmbJpeg ||
      extractLargestEmbeddedJpeg(buffer, { minBytes: 1024 });
    if (!jpegBytes) return null;

    const normalized = ensureJpegExifOrientation(jpegBytes, outerOrientation);
    const blob = new Blob([normalized], { type: 'image/jpeg' });
    const url = URL.createObjectURL(blob);
    setCacheEntry(cacheKey, {
      url,
      source: 'raw-embedded',
      isObjectUrl: true,
    });
    return url;
  } catch {
    return null;
  }
}

/**
 * Extracts a lightweight upright thumbnail Blob (EXIF APP1 thumbnail inside JPGs, or THMB/PRVW inside RAW/CR3)
 * via tiny Range/Slice requests so both Filmstrip thumbnails and visual similarity fingerprinting
 * receive properly oriented upright frames.
 */
export async function extractFastHeaderThumbnailBlob(
  token: string | null | undefined,
  file: DrivePhotoFile,
  signal?: AbortSignal
): Promise<Blob | null> {
  try {
    let jpegBytes: Uint8Array | null = null;
    let outerOrientation: number | undefined = orientationHintCache.get(file.id);

    if (file.isRaw) {
      // Stage 1: First 512 KB covers Canon CR3 CMT1 + THMB box and most RAW embedded thumbnails
      const buf512 = await fetchPhotoBytes(
        token,
        file,
        getHeaderRange(file, 524288),
        signal
      );
      const cr3Info =
        file.fileExtension === 'cr3' ? findCanonPrvwOrExifInCr3(buf512) : {};
      outerOrientation =
        resolveRawHeaderOrientation(file, buf512, cr3Info.cmt1) ??
        outerOrientation;
      jpegBytes =
        cr3Info.prvwJpeg ||
        cr3Info.thmbJpeg ||
        extractLargestEmbeddedJpeg(buf512, { minBytes: 1024 });

      // Stage 2: Escalate to 2 MB when Sony/Nikon/CR3 places embedded thumbnail deeper
      if (
        !jpegBytes &&
        (file.sizeBytes === 0 || file.sizeBytes > 524288) &&
        !signal?.aborted
      ) {
        const buf2m = await fetchPhotoBytes(
          token,
          file,
          getHeaderRange(file, 2097152),
          signal
        );
        const cr3Info2 =
          file.fileExtension === 'cr3' ? findCanonPrvwOrExifInCr3(buf2m) : {};
        outerOrientation =
          resolveRawHeaderOrientation(file, buf2m, cr3Info2.cmt1) ??
          outerOrientation;
        jpegBytes =
          cr3Info2.prvwJpeg ||
          cr3Info2.thmbJpeg ||
          extractLargestEmbeddedJpeg(buf2m, { minBytes: 1024 });
      }
    } else {
      // Standard JPG: read outer EXIF Orientation first, then extract embedded APP1 thumbnail
      const buf128 = await fetchPhotoBytes(
        token,
        file,
        getHeaderRange(file, 131072),
        signal
      );
      outerOrientation =
        parseTiffIfdMetadata(new Uint8Array(buf128), 0)?.orientation ??
        outerOrientation;
      rememberOrientationHint(file.id, outerOrientation);
      jpegBytes = extractLargestEmbeddedJpeg(buf128, {
        minBytes: 1024,
        startOffset: 12,
      });
    }

    if (!jpegBytes) return null;

    const normalized = ensureJpegExifOrientation(jpegBytes, outerOrientation);
    return new Blob([normalized], { type: 'image/jpeg' });
  } catch {
    return null;
  }
}

export async function resolveFastHeaderThumbnailUrl(
  token: string | null | undefined,
  file: DrivePhotoFile,
  signal?: AbortSignal
): Promise<string | null> {
  const blob = await extractFastHeaderThumbnailBlob(token, file, signal);
  if (!blob) return null;
  return URL.createObjectURL(blob);
}

/**
 * Resolves a displayable high-resolution upright preview URL + EXIF for any Google Drive or Local/SD photo or RAW file (including Canon CR3).
 */
export async function resolvePhotoMedia(
  token: string | null | undefined,
  file: DrivePhotoFile,
  options: { preferFullRawDecode?: boolean; signal?: AbortSignal } = {}
): Promise<ResolvedPhotoMedia> {
  const isLocal = Boolean(file.sourceKind && file.sourceKind !== 'drive');
  const cacheKey = `${file.id}:${options.preferFullRawDecode ? 'full' : 'auto'}`;
  const cached = mediaCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  // Fast path for standard local images (zero copy ObjectURL + header slice EXIF)
  if (isLocal && !file.isRaw) {
    if (
      file.sourceKind === 'android-saf' &&
      file.nativeUri &&
      window.FrameCullNative?.getFullMediaUrl
    ) {
      const nativeUrl = await window.FrameCullNative.getFullMediaUrl(
        file.nativeUri
      );
      if (nativeUrl) {
        const headerSlice = await fetchPhotoBytes(
          token,
          file,
          getHeaderRange(file, 131072),
          options.signal
        ).catch(() => null);
        const exif = headerSlice ? await parseExifSafe(headerSlice) : undefined;
        const resolved: ResolvedPhotoMedia = {
          url: nativeUrl,
          source: 'local-media',
          exif: mergeExifWithDrive(file, exif),
          isObjectUrl: nativeUrl.startsWith('blob:'),
        };
        setCacheEntry(cacheKey, resolved);
        return resolved;
      }
    }

    const blobFile =
      file.localFile || (file.fsHandle ? await file.fsHandle.getFile() : null);
    if (blobFile) {
      const headerSlice = await blobFile
        .slice(0, Math.min(blobFile.size, 131072))
        .arrayBuffer()
        .catch(() => null);
      const exif = headerSlice ? await parseExifSafe(headerSlice) : undefined;
      const url = URL.createObjectURL(blobFile);
      const resolved: ResolvedPhotoMedia = {
        url,
        source: 'local-media',
        exif: mergeExifWithDrive(file, exif),
        isObjectUrl: true,
      };
      setCacheEntry(cacheKey, resolved);
      return resolved;
    }

    const buffer = await fetchPhotoBytes(token, file, undefined, options.signal);
    const exif = await parseExifSafe(buffer);
    const blob = new Blob([buffer], { type: file.mimeType || 'image/jpeg' });
    const url = URL.createObjectURL(blob);
    const resolved: ResolvedPhotoMedia = {
      url,
      source: 'local-media',
      exif: mergeExifWithDrive(file, exif),
      isObjectUrl: true,
    };
    setCacheEntry(cacheKey, resolved);
    return resolved;
  }

  // Fast path when Drive provides a thumbnailLink (works in ~100ms; UI seamlessly falls back to preferFullRawDecode on img error or zoom)
  const thumbUrl = !isLocal ? getUpgradeThumbnailUrl(file.thumbnailLink) : null;
  if (!options.preferFullRawDecode && thumbUrl) {
    const resolved: ResolvedPhotoMedia = {
      url: thumbUrl,
      source: 'drive-thumbnail',
      exif: mergeExifWithDrive(file),
      isObjectUrl: false,
    };
    setCacheEntry(cacheKey, resolved);
    return resolved;
  }

  // For RAW files (CR3, CR2, NEF, ARW, DNG, ORF, RW2, RAF, PEF...):
  if (file.isRaw) {
    // Fast Zero-Base64 Android SAF native extractor when available (writes oriented preview JPEG directly to cacheDir)
    if (
      file.sourceKind === 'android-saf' &&
      file.nativeUri &&
      window.FrameCullNative?.extractRawPreviewUrl
    ) {
      const [nativeExtracted, headerBuf] = await Promise.all([
        window.FrameCullNative.extractRawPreviewUrl(file.nativeUri),
        fetchPhotoBytes(
          token,
          file,
          getHeaderRange(file, 262144),
          options.signal
        ).catch(() => null),
      ]);

      if (nativeExtracted?.url) {
        let exif: ParsedExif | undefined;
        if (headerBuf) {
          if (file.fileExtension === 'cr3') {
            const cr3Hdr = findCanonPrvwOrExifInCr3(headerBuf);
            const m1 = cr3Hdr.cmt1
              ? parseTiffIfdMetadata(cr3Hdr.cmt1, 0)
              : undefined;
            const m2 = cr3Hdr.cmt2
              ? parseTiffIfdMetadata(cr3Hdr.cmt2, 0)
              : undefined;
            exif = binaryMetaToParsedExif(m1, m2);
          } else {
            exif = await parseExifSafe(headerBuf);
          }
        }
        if (nativeExtracted.orientation) {
          rememberOrientationHint(file.id, nativeExtracted.orientation);
        }
        const resolved: ResolvedPhotoMedia = {
          url: nativeExtracted.url,
          source: 'raw-embedded',
          exif: mergeExifWithDrive(file, exif),
          isObjectUrl: nativeExtracted.url.startsWith('blob:'),
        };
        setCacheEntry(cacheKey, resolved);
        return resolved;
      }
    }

    // Stage 1: Read first 4 MB (covers metadata + embedded preview in most RAWs & CR3s)
    let buffer = await fetchPhotoBytes(
      token,
      file,
      getHeaderRange(file, 4194304),
      options.signal
    );

    let cr3Info: Cr3BoxParseResult =
      file.fileExtension === 'cr3' ? findCanonPrvwOrExifInCr3(buffer) : {};
    let outerOrientation = resolveRawHeaderOrientation(
      file,
      buffer,
      cr3Info.cmt1
    );

    let jpegBytes: Uint8Array | null =
      cr3Info.prvwJpeg ||
      extractLargestEmbeddedJpeg(buffer) ||
      cr3Info.thmbJpeg ||
      null;

    // Stage 2 for Canon CR3: if PRVW JPEG exceeded the initial 4 MB slice, fetch ONLY the exact PRVW UUID box!
    if (
      file.fileExtension === 'cr3' &&
      (!jpegBytes || jpegBytes.byteLength < 45000) &&
      (file.sizeBytes === 0 || file.sizeBytes > 4194304)
    ) {
      const targetBox =
        cr3Info.prvwBoxRange ||
        (await locateCanonCr3PrvwBoxRange(token, file, options.signal));

      if (
        targetBox &&
        targetBox.end > targetBox.start &&
        targetBox.end - targetBox.start <= 20 * 1024 * 1024
      ) {
        const prvwBuf = await fetchPhotoBytes(
          token,
          file,
          { start: targetBox.start, end: targetBox.end - 1 },
          options.signal
        ).catch(() => null);
        if (prvwBuf) {
          const parsedPrvw = findCanonPrvwOrExifInCr3(prvwBuf);
          const candidate =
            parsedPrvw.prvwJpeg ||
            extractLargestEmbeddedJpeg(prvwBuf, { minBytes: 2048 });
          if (
            candidate &&
            (!jpegBytes || candidate.byteLength > jpegBytes.byteLength)
          ) {
            jpegBytes = candidate;
          }
        }
      }
    }

    // Stage 3 for large RAWs (Sony ARW, Nikon NEF, Canon CR2, high-MP CR3): try 12 MB header slice before full file
    if (
      (!jpegBytes || jpegBytes.byteLength < 35000) &&
      (file.sizeBytes === 0 || file.sizeBytes > 4194304)
    ) {
      const buf12m = await fetchPhotoBytes(
        token,
        file,
        getHeaderRange(file, 12 * 1024 * 1024),
        options.signal
      ).catch(() => null);

      if (buf12m) {
        if (file.fileExtension === 'cr3') {
          const cr312 = findCanonPrvwOrExifInCr3(buf12m);
          if (!cr3Info.cmt1 && cr312.cmt1) cr3Info.cmt1 = cr312.cmt1;
          if (!cr3Info.cmt2 && cr312.cmt2) cr3Info.cmt2 = cr312.cmt2;
          outerOrientation =
            resolveRawHeaderOrientation(file, buf12m, cr3Info.cmt1) ??
            outerOrientation;
          const cand =
            cr312.prvwJpeg || extractLargestEmbeddedJpeg(buf12m) || cr312.thmbJpeg;
          if (cand && (!jpegBytes || cand.byteLength > jpegBytes.byteLength)) {
            jpegBytes = cand;
          }
        } else {
          outerOrientation =
            resolveRawHeaderOrientation(file, buf12m) ?? outerOrientation;
          const cand = extractLargestEmbeddedJpeg(buf12m);
          if (cand && (!jpegBytes || cand.byteLength > jpegBytes.byteLength)) {
            jpegBytes = cand;
          }
        }
        buffer = buf12m;
      }
    }

    // Final Stage 4 fallback for desktop/Drive RAWs where preview is stored at end of file (e.g. certain DNG/PEF)
    if (
      (!jpegBytes || jpegBytes.byteLength < 35000) &&
      file.sourceKind !== 'android-saf' &&
      file.sizeBytes > 12 * 1024 * 1024
    ) {
      const fullBuf = await fetchPhotoBytes(
        token,
        file,
        undefined,
        options.signal
      ).catch(() => null);
      if (fullBuf) {
        outerOrientation =
          resolveRawHeaderOrientation(file, fullBuf, cr3Info.cmt1) ??
          outerOrientation;
        const fullJpeg = extractLargestEmbeddedJpeg(fullBuf);
        if (
          fullJpeg &&
          (!jpegBytes || fullJpeg.byteLength > jpegBytes.byteLength)
        ) {
          jpegBytes = fullJpeg;
        }
        buffer = fullBuf;
      }
    }

    let exif: ParsedExif | undefined;
    if (cr3Info.cmt1 || cr3Info.cmt2) {
      const m1 = cr3Info.cmt1
        ? parseTiffIfdMetadata(cr3Info.cmt1, 0)
        : undefined;
      const m2 = cr3Info.cmt2
        ? parseTiffIfdMetadata(cr3Info.cmt2, 0)
        : undefined;
      exif = binaryMetaToParsedExif(m1, m2);
    }
    if (!exif) {
      exif = await parseExifSafe(buffer);
    }
    if (!exif && jpegBytes) {
      exif = await parseExifSafe(jpegBytes);
    }
    if (!outerOrientation && exif?.orientation) {
      outerOrientation = exif.orientation;
      rememberOrientationHint(file.id, outerOrientation);
    }

    if (jpegBytes) {
      const normalized = ensureJpegExifOrientation(jpegBytes, outerOrientation);
      const blob = new Blob([normalized], { type: 'image/jpeg' });
      const url = URL.createObjectURL(blob);
      const resolved: ResolvedPhotoMedia = {
        url,
        source: 'raw-embedded',
        exif: mergeExifWithDrive(file, exif),
        isObjectUrl: true,
      };
      setCacheEntry(cacheKey, resolved);
      return resolved;
    }

    // Fallback to Drive thumbnail if RAW had no embedded JPEG
    if (thumbUrl) {
      const resolved: ResolvedPhotoMedia = {
        url: thumbUrl,
        source: 'drive-thumbnail',
        exif: mergeExifWithDrive(file, exif),
        isObjectUrl: false,
      };
      setCacheEntry(cacheKey, resolved);
      return resolved;
    }

    throw new Error(`Soubor ${file.name} neobsahuje čitelný náhled JPEG.`);
  }

  // Standard Drive image full media fetch (when thumbnailLink is absent or full quality requested)
  const buffer = await fetchPhotoBytes(token, file, undefined, options.signal);
  const exif = await parseExifSafe(buffer);
  const mime = file.mimeType || 'image/jpeg';
  const blob = new Blob([buffer], { type: mime });
  const url = URL.createObjectURL(blob);
  const resolved: ResolvedPhotoMedia = {
    url,
    source: 'drive-media',
    exif: mergeExifWithDrive(file, exif),
    isObjectUrl: true,
  };
  setCacheEntry(cacheKey, resolved);
  return resolved;
}

export function formatShutterSpeed(exposureTime?: number): string | null {
  if (!exposureTime || exposureTime <= 0) return null;
  if (exposureTime >= 1) {
    return `${exposureTime.toFixed(1).replace(/\.0$/, '')}s`;
  }
  const denom = Math.round(1 / exposureTime);
  return `1/${denom}s`;
}
