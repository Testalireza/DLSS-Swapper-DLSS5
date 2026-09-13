'use strict';

const fsp = require('fs').promises;

/**
 * Minimal, dependency-free PE (Portable Executable) reader.
 *
 * Why hand-rolled: on Windows we could shell out to PowerShell for file
 * version info, but the core must stay cross-platform (and testable). Reading
 * the VS_VERSION_INFO resource directly works on any OS and is how we detect
 * real DLSS/Streamline versions instead of trusting file names.
 */

const RT_VERSION = 16;
const VS_FIXEDFILEINFO_SIGNATURE = 0xfeef04bd;

class PeParseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PeParseError';
  }
}

function u16(buf, off) {
  if (off < 0 || off + 2 > buf.length) throw new PeParseError(`read u16 out of bounds @${off}`);
  return buf.readUInt16LE(off);
}
function u32(buf, off) {
  if (off < 0 || off + 4 > buf.length) throw new PeParseError(`read u32 out of bounds @${off}`);
  return buf.readUInt32LE(off);
}

function align4(n) {
  return (n + 3) & ~3;
}

/** Read a NUL-terminated UTF-16LE string; returns {text, end}. */
function readUtf16z(buf, off, limit) {
  let end = off;
  while (end + 1 < limit && !(buf[end] === 0 && buf[end + 1] === 0)) end += 2;
  return { text: buf.toString('utf16le', off, end), end: end + 2 };
}

/**
 * Parse PE headers (no resource walking).
 * @param {Buffer} buf
 */
function parsePeHeaders(buf) {
  if (buf.length < 64 || buf.toString('ascii', 0, 2) !== 'MZ') {
    throw new PeParseError('not a PE file (missing MZ header)');
  }
  const e_lfanew = u32(buf, 0x3c);
  if (buf.toString('ascii', e_lfanew, e_lfanew + 4) !== 'PE\0\0') {
    throw new PeParseError('not a PE file (missing PE signature)');
  }
  const coff = e_lfanew + 4;
  const machine = u16(buf, coff);
  const numSections = u16(buf, coff + 2);
  const sizeOptHdr = u16(buf, coff + 16);
  const characteristics = u16(buf, coff + 18);
  const opt = coff + 20;
  const magic = u16(buf, opt);
  const isPe32Plus = magic === 0x20b;
  if (magic !== 0x10b && !isPe32Plus) throw new PeParseError(`unknown optional header magic 0x${magic.toString(16)}`);

  const numRvaAndSizes = u32(buf, opt + (isPe32Plus ? 108 : 92));
  const dataDir = opt + (isPe32Plus ? 112 : 96);
  const subsystem = u16(buf, opt + (isPe32Plus ? 68 : 68));
  const dllCharacteristics = u16(buf, opt + 70);

  const sections = [];
  const secTable = opt + sizeOptHdr;
  for (let i = 0; i < numSections; i++) {
    const s = secTable + i * 40;
    if (s + 40 > buf.length) break;
    sections.push({
      name: buf.toString('ascii', s, s + 8).replace(/\0.*$/, ''),
      virtualSize: u32(buf, s + 8),
      virtualAddress: u32(buf, s + 12),
      rawSize: u32(buf, s + 16),
      rawPtr: u32(buf, s + 20),
      characteristics: u32(buf, s + 36),
    });
  }

  let resourceRva = 0;
  let resourceSize = 0;
  if (numRvaAndSizes > 2) {
    resourceRva = u32(buf, dataDir + 2 * 8);
    resourceSize = u32(buf, dataDir + 2 * 8 + 4);
  }

  return {
    machine,
    is64bit: isPe32Plus || machine === 0xaa64,
    isDll: (characteristics & 0x2000) !== 0,
    subsystem,
    dllCharacteristics,
    numSections,
    sections,
    resourceRva,
    resourceSize,
    e_lfanew,
    sizeOptHdr,
  };
}

function rvaToOffset(headers, rva) {
  for (const s of headers.sections) {
    const vsize = Math.max(s.virtualSize, s.rawSize);
    if (rva >= s.virtualAddress && rva < s.virtualAddress + vsize) {
      return s.rawPtr + (rva - s.virtualAddress);
    }
  }
  throw new PeParseError(`RVA 0x${rva.toString(16)} not inside any section`);
}

/**
 * Walk one level of a resource directory looking for `id`.
 * Returns the absolute file offset of the entry's target (subdir or data entry)
 * or null when not found.
 */
function findResourceEntry(buf, base, dirOffset, id, wantDirectory) {
  const named = u16(buf, dirOffset + 12);
  const byId = u16(buf, dirOffset + 14);
  const entriesStart = dirOffset + 16;
  // ID entries come after named entries.
  for (let i = 0; i < byId; i++) {
    const e = entriesStart + (named + i) * 8;
    const nameOrId = u32(buf, e);
    const offsetToData = u32(buf, e + 4);
    if (nameOrId === id) {
      const isDir = (offsetToData & 0x80000000) !== 0;
      if (isDir !== wantDirectory) return null;
      return isDir ? base + (offsetToData & 0x7fffffff) : base + offsetToData;
    }
  }
  return null;
}

/** First entry under a directory (any id). */
function firstResourceEntry(buf, base, dirOffset, wantDirectory) {
  const named = u16(buf, dirOffset + 12);
  const byId = u16(buf, dirOffset + 14);
  const total = named + byId;
  if (total === 0) return null;
  const e = dirOffset + 16;
  const offsetToData = u32(buf, e + 4);
  const isDir = (offsetToData & 0x80000000) !== 0;
  if (isDir !== wantDirectory) return null;
  return isDir ? base + (offsetToData & 0x7fffffff) : base + offsetToData;
}

function hi(v) { return (v >>> 16) & 0xffff; }
function lo(v) { return v & 0xffff; }

function versionFromDwords(ms, ls) {
  return `${hi(ms)}.${lo(ms)}.${hi(ls)}.${lo(ls)}`;
}

/**
 * Parse a VS_VERSIONINFO blob (the RT_VERSION resource payload).
 * @param {Buffer} buf Full file buffer.
 * @param {number} off Absolute offset of the VS_VERSIONINFO structure.
 */
function parseVersionInfoBlob(buf, off, blobLength) {
  const limit = Math.min(buf.length, off + blobLength);
  const wLength = u16(buf, off);
  const wValueLength = u16(buf, off + 2);
  // const wType = u16(buf, off + 4);
  const key = readUtf16z(buf, off + 6, limit);
  if (key.text !== 'VS_VERSION_INFO') {
    throw new PeParseError(`unexpected version info key "${key.text}"`);
  }
  let pos = align4(key.end);
  if (u32(buf, pos) !== VS_FIXEDFILEINFO_SIGNATURE) {
    throw new PeParseError('VS_FIXEDFILEINFO signature not found');
  }
  const fixed = {
    fileVersionMS: u32(buf, pos + 8),
    fileVersionLS: u32(buf, pos + 12),
    productVersionMS: u32(buf, pos + 16),
    productVersionLS: u32(buf, pos + 20),
    fileFlags: u32(buf, pos + 28),
    fileOS: u32(buf, pos + 32),
    fileType: u32(buf, pos + 36),
  };
  const result = {
    fileVersion: versionFromDwords(fixed.fileVersionMS, fixed.fileVersionLS),
    productVersion: versionFromDwords(fixed.productVersionMS, fixed.productVersionLS),
    strings: {},
  };

  // Children: StringFileInfo / VarFileInfo
  pos = align4(pos + 52); // fixed info is 52 bytes
  const end = Math.min(limit, off + wLength);
  while (pos + 6 < end) {
    const childLen = u16(buf, pos);
    if (childLen === 0 || pos + childLen > limit) break;
    const childValueLen = u16(buf, pos + 2);
    const childType = u16(buf, pos + 4);
    const childKey = readUtf16z(buf, pos + 6, pos + childLen);
    if (childKey.text === 'StringFileInfo') {
      let tablePos = align4(childKey.end);
      const tableEnd = pos + childLen;
      while (tablePos + 6 < tableEnd) {
        // StringTable (e.g. "040904b0")
        const tableLen = u16(buf, tablePos);
        if (tableLen === 0 || tablePos + tableLen > limit) break;
        const tableKey = readUtf16z(buf, tablePos + 6, tablePos + tableLen);
        let strPos = align4(tableKey.end);
        const strEnd = tablePos + tableLen;
        while (strPos + 6 < strEnd) {
          const strLen = u16(buf, strPos);
          if (strLen === 0 || strPos + strLen > limit) break;
          const strValueLen = u16(buf, strPos + 2); // chars incl. NUL
          const strType = u16(buf, strPos + 4);
          const sKey = readUtf16z(buf, strPos + 6, strPos + strLen);
          let valPos = align4(sKey.end);
          let value = '';
          if (strType === 1 && strValueLen > 0) {
            // UTF-16 text, wValueLength chars including terminator
            const raw = buf.toString('utf16le', valPos, Math.min(strPos + strLen, valPos + strValueLen * 2));
            value = raw.replace(/\0.*$/s, '');
          } else if (strType === 0 && strValueLen > 0) {
            value = buf.toString('ascii', valPos, Math.min(strPos + strLen, valPos + strValueLen)).replace(/\0.*$/s, '');
          }
          if (sKey.text) result.strings[sKey.text] = value;
          strPos = align4(strPos + strLen);
        }
        void childType;
        void childValueLen;
        tablePos = align4(tablePos + tableLen);
      }
    }
    pos = align4(pos + childLen);
  }

  // Convenience fields
  result.fileDescription = result.strings.FileDescription || null;
  result.productName = result.strings.ProductName || null;
  result.companyName = result.strings.CompanyName || null;
  result.originalFilename = result.strings.OriginalFilename || null;
  result.stringFileVersion = result.strings.FileVersion || null;
  return result;
}

/**
 * Extract version information from a PE buffer.
 * @param {Buffer} buf
 * @returns {ReturnType<typeof parseVersionInfoBlob> & {headers: object}}
 * @throws {PeParseError} when the file is not a PE or has no version resource.
 */
function parsePeVersion(buf) {
  const headers = parsePeHeaders(buf);
  if (!headers.resourceRva) throw new PeParseError('no resource directory');
  const base = rvaToOffset(headers, headers.resourceRva);
  const typeDir = findResourceEntry(buf, base, base, RT_VERSION, true);
  if (!typeDir) throw new PeParseError('no RT_VERSION resource');
  const langDir = firstResourceEntry(buf, base, typeDir, true);
  if (!langDir) throw new PeParseError('RT_VERSION has no language entries');
  const dataEntry = firstResourceEntry(buf, base, langDir, false);
  if (!dataEntry) throw new PeParseError('no version data entry');
  const dataRva = u32(buf, dataEntry);
  const dataSize = u32(buf, dataEntry + 4);
  const dataOff = rvaToOffset(headers, dataRva);
  const info = parseVersionInfoBlob(buf, dataOff, dataSize);
  return { ...info, headers: { machine: headers.machine, is64bit: headers.is64bit, isDll: headers.isDll } };
}

/**
 * Read version info from a file on disk. Returns null (not throw) when the
 * file is missing or isn't a PE with version info — callers treat that as
 * "version unknown" and fall back to hashes.
 */
async function readFileVersion(filePath) {
  try {
    const buf = await fsp.readFile(filePath);
    return parsePeVersion(buf);
  } catch (err) {
    if (err instanceof PeParseError) return { error: err.message };
    return { error: err.message };
  }
}

/**
 * Parse the import directory (data directory index 1) and return the list of
 * imported DLL names (lowercased). This is how the analyzer detects the real
 * graphics API of an executable instead of guessing from file names:
 * d3d12.dll → DirectX 12, d3d11.dll → DirectX 11, vulkan-1.dll → Vulkan, ...
 *
 * Returns [] when the binary has no imports we can read (never throws).
 */
function parsePeImports(buf) {
  try {
    const headers = parsePeHeaders(buf);
    const opt = headers.e_lfanew + 24;
    const isPe32Plus = u16(buf, opt) === 0x20b;
    const dataDir = opt + (isPe32Plus ? 112 : 96);
    const numRva = u32(buf, opt + (isPe32Plus ? 108 : 92));
    if (numRva < 2) return [];
    const importRva = u32(buf, dataDir + 1 * 8);
    const importSize = u32(buf, dataDir + 1 * 8 + 4);
    if (!importRva || !importSize) return [];
    let off = rvaToOffset(headers, importRva);
    const names = [];
    // Each IMAGE_IMPORT_DESCRIPTOR is 20 bytes; terminated by an all-zero entry.
    for (let i = 0; i < 256; i++) {
      const nameRva = u32(buf, off + 12);
      const allZero = [0, 4, 8, 12, 16].every((d) => u32(buf, off + d) === 0);
      if (allZero || nameRva === 0) break;
      try {
        const nameOff = rvaToOffset(headers, nameRva);
        let end = nameOff;
        while (end < buf.length && buf[end] !== 0) end++;
        const name = buf.toString('ascii', nameOff, end);
        if (name) names.push(name.toLowerCase());
      } catch {
        /* unreadable name — skip */
      }
      off += 20;
    }
    return names;
  } catch {
    return [];
  }
}

/** Read imports from a file on disk; [] on any failure. */
async function readFileImports(filePath) {
  try {
    const buf = await fsp.readFile(filePath);
    return parsePeImports(buf);
  } catch {
    return [];
  }
}

module.exports = {
  parsePeHeaders,
  parsePeVersion,
  readFileVersion,
  parsePeImports,
  readFileImports,
  PeParseError,
};
