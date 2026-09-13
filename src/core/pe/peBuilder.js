'use strict';

/**
 * Minimal PE builder.
 *
 * This is NOT a compiler — it produces tiny, structurally valid PE DLL files
 * carrying a real VS_VERSION_INFO resource. It exists so that:
 *
 *  1. Tests can generate fixture "DLLs" with known versions and prove the
 *     version parser round-trips against genuine PE structures (no mocks).
 *  2. The demo seeder can create clearly-synthetic stand-in files for the
 *     browser dev preview.
 *
 * Real runtime/injection binaries always come from the user's imports or
 * configured providers — never from this module.
 */

const FILE_ALIGN = 0x200;
const SECTION_ALIGN = 0x1000;

function align(n, a) {
  return Math.ceil(n / a) * a;
}

function utf16z(str) {
  return Buffer.concat([Buffer.from(str, 'utf16le'), Buffer.from([0, 0])]);
}

function pad4(buf) {
  const rem = buf.length % 4;
  return rem === 0 ? buf : Buffer.concat([buf, Buffer.alloc(4 - rem)]);
}

/** Parse "a.b.c.d" (c/d optional) into [ms, ls] dwords. */
function versionDwords(v) {
  const p = String(v).split('.').map((n) => parseInt(n, 10) || 0);
  while (p.length < 4) p.push(0);
  const ms = ((p[0] & 0xffff) << 16) | (p[1] & 0xffff);
  const ls = ((p[2] & 0xffff) << 16) | (p[3] & 0xffff);
  return [ms >>> 0, ls >>> 0];
}

/** Build one String resource entry ("FileDescription" => "..."). */
function buildStringEntry(key, value) {
  const keyBuf = utf16z(key);
  const valueBuf = Buffer.concat([Buffer.from(value, 'utf16le'), Buffer.from([0, 0])]);
  const valueChars = value.length + 1; // includes NUL
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0); // wLength placeholder
  head.writeUInt16LE(valueChars, 2); // wValueLength
  head.writeUInt16LE(1, 4); // wType: text
  const body = pad4(Buffer.concat([head, keyBuf]));
  const full = pad4(Buffer.concat([body, valueBuf]));
  full.writeUInt16LE(full.length, 0);
  return full;
}

/** Build the complete VS_VERSION_INFO blob. */
function buildVersionInfo(opts) {
  const [fvMs, fvLs] = versionDwords(opts.fileVersion);
  const [pvMs, pvLs] = versionDwords(opts.productVersion || opts.fileVersion);

  // VS_FIXEDFILEINFO (52 bytes)
  const fixed = Buffer.alloc(52);
  fixed.writeUInt32LE(0xfeef04bd, 0);
  fixed.writeUInt32LE(0x00010000, 4);
  fixed.writeUInt32LE(fvMs, 8);
  fixed.writeUInt32LE(fvLs, 12);
  fixed.writeUInt32LE(pvMs, 16);
  fixed.writeUInt32LE(pvLs, 20);
  fixed.writeUInt32LE(0x0000003f, 24); // flags mask
  fixed.writeUInt32LE(0, 28); // flags
  fixed.writeUInt32LE(0x00040004, 32); // VOS_NT_WINDOWS32
  fixed.writeUInt32LE(2, 36); // VFT_DLL
  fixed.writeUInt32LE(0, 40);

  // Strings
  const strings = [];
  const pushString = (k, v) => { if (v != null) strings.push(buildStringEntry(k, String(v))); };
  pushString('CompanyName', opts.companyName);
  pushString('FileDescription', opts.fileDescription);
  pushString('FileVersion', opts.fileVersion);
  pushString('InternalName', opts.internalName || opts.originalFilename);
  pushString('OriginalFilename', opts.originalFilename);
  pushString('ProductName', opts.productName);
  pushString('ProductVersion', opts.productVersion || opts.fileVersion);

  // StringTable "040904b0"
  const tableHead = Buffer.alloc(6);
  tableHead.writeUInt16LE(0, 0);
  tableHead.writeUInt16LE(0, 2);
  tableHead.writeUInt16LE(1, 4); // text
  const stringTable = pad4(Buffer.concat([tableHead, utf16z('040904b0'), ...strings]));
  stringTable.writeUInt16LE(stringTable.length, 0);

  // StringFileInfo
  const sfiHead = Buffer.alloc(6);
  sfiHead.writeUInt16LE(0, 0);
  sfiHead.writeUInt16LE(0, 2);
  sfiHead.writeUInt16LE(1, 4);
  const stringFileInfo = pad4(Buffer.concat([sfiHead, utf16z('StringFileInfo'), stringTable]));
  stringFileInfo.writeUInt16LE(stringFileInfo.length, 0);

  // VarFileInfo (translation)
  const varHead = Buffer.alloc(6);
  varHead.writeUInt16LE(0, 0);
  varHead.writeUInt16LE(4, 2);
  varHead.writeUInt16LE(0, 4); // binary
  const varValue = Buffer.alloc(4);
  varValue.writeUInt16LE(0x0409, 0);
  varValue.writeUInt16LE(0x04b0, 2);
  const varFileInfo = pad4(Buffer.concat([varHead, utf16z('VarFileInfo'), varValue]));
  varFileInfo.writeUInt16LE(varFileInfo.length, 0);

  // VS_VERSION_INFO root (szKey must be padded so Value aligns to 4 bytes)
  const rootHead = Buffer.alloc(6);
  rootHead.writeUInt16LE(0, 0);
  rootHead.writeUInt16LE(52, 2); // wValueLength = sizeof(VS_FIXEDFILEINFO)
  rootHead.writeUInt16LE(0, 4); // binary
  const rootPrefix = pad4(Buffer.concat([rootHead, utf16z('VS_VERSION_INFO')]));
  const root = pad4(Buffer.concat([rootPrefix, fixed, stringFileInfo, varFileInfo]));
  root.writeUInt16LE(root.length, 0);
  return root;
}

/** Build the .rsrc section image (resource directory tree + version blob). */
function buildResourceSection(versionInfoBlob) {
  const RT_VERSION = 16;
  const dirSize = 16;
  const entrySize = 8;
  const dataEntrySize = 16;

  // Fixed layout: root -> type dir -> lang dir -> data entry -> blob
  const rootOff = 0;
  const typeDirOff = rootOff + dirSize + entrySize; // 24
  const langDirOff = typeDirOff + dirSize + entrySize; // 48
  const dataEntryOff = langDirOff + dirSize + entrySize; // 72
  const blobOff = dataEntryOff + dataEntrySize; // 88
  const blobRvaPlaceholder = 0; // patched by caller context

  const sec = Buffer.alloc(blobOff + versionInfoBlob.length);

  const writeDir = (off, idEntries) => {
    sec.writeUInt32LE(0, off); // characteristics
    sec.writeUInt32LE(0, off + 4); // timestamp
    sec.writeUInt16LE(0, off + 8); // major
    sec.writeUInt16LE(0, off + 10); // minor
    sec.writeUInt16LE(0, off + 12); // named entries
    sec.writeUInt16LE(idEntries, off + 14);
  };
  const writeEntry = (off, id, target, isDir) => {
    sec.writeUInt32LE(id >>> 0, off);
    sec.writeUInt32LE((isDir ? 0x80000000 : 0) + target, off + 4);
  };

  writeDir(rootOff, 1);
  writeEntry(rootOff + 16, RT_VERSION, typeDirOff, true);
  writeDir(typeDirOff, 1);
  writeEntry(typeDirOff + 16, 0x0409, langDirOff, true); // en-US
  writeDir(langDirOff, 1);
  writeEntry(langDirOff + 16, 0x0409, dataEntryOff, false);

  // Data entry — RVA patched later (needs section RVA).
  sec.writeUInt32LE(0, dataEntryOff); // OffsetToData (RVA placeholder)
  sec.writeUInt32LE(versionInfoBlob.length, dataEntryOff + 4);
  sec.writeUInt32LE(0, dataEntryOff + 8); // codepage
  sec.writeUInt32LE(0, dataEntryOff + 12);

  versionInfoBlob.copy(sec, blobOff);
  return { buffer: sec, dataEntryOff, blobOff };
}

/**
 * Build a minimal PE DLL buffer.
 *
 * @param {object} opts
 * @param {string} opts.fileVersion  e.g. '310.7.129.0'
 * @param {string} [opts.productVersion]
 * @param {string} [opts.fileDescription]
 * @param {string} [opts.productName]
 * @param {string} [opts.companyName]
 * @param {string} [opts.originalFilename] e.g. 'nvngx_dlss.dll'
 * @param {'x64'|'x86'} [opts.arch='x64']
 * @returns {Buffer}
 */
function buildPeDll(opts = {}) {
  const arch = opts.arch === 'x86' ? 'x86' : 'x64';
  const isPe32Plus = arch === 'x64';
  const optSize = isPe32Plus ? 112 + 16 * 8 : 96 + 16 * 8;

  const versionInfoBlob = buildVersionInfo({
    fileVersion: opts.fileVersion || '1.0.0.0',
    productVersion: opts.productVersion,
    fileDescription: opts.fileDescription ?? 'Synthetic test binary (DLSS Swapper 5 fixture)',
    productName: opts.productName ?? 'DLSS5 Test Fixture',
    companyName: opts.companyName ?? 'DLSS Swapper 5 Test Tooling',
    originalFilename: opts.originalFilename ?? 'fixture.dll',
    internalName: opts.internalName,
  });

  const { buffer: rsrcSec, dataEntryOff, blobOff } = buildResourceSection(versionInfoBlob);

  // Two sections: .text (tiny) and .rsrc.
  const textRaw = Buffer.alloc(FILE_ALIGN); // zero-filled "code"
  textRaw[0] = 0xc3; // ret

  const dosSize = 64;
  const headersEnd = dosSize + 4 + 20 + optSize + 2 * 40;
  const sizeOfHeaders = align(headersEnd, FILE_ALIGN);

  const textPtr = sizeOfHeaders;
  const rsrcPtr = align(textPtr + textRaw.length, FILE_ALIGN);
  const rsrcRawSize = align(rsrcSec.length, FILE_ALIGN);
  const imageSize = align(SECTION_ALIGN, SECTION_ALIGN) + align(2 * SECTION_ALIGN, SECTION_ALIGN); // 2 sections mapped

  const textRva = SECTION_ALIGN; // 0x1000
  const rsrcRva = 2 * SECTION_ALIGN; // 0x2000

  const buf = Buffer.alloc(align(rsrcPtr + rsrcRawSize, FILE_ALIGN));

  // --- DOS header ---
  buf.write('MZ', 0, 'ascii');
  buf.writeUInt32LE(dosSize, 0x3c); // e_lfanew

  // --- PE signature + COFF ---
  const pe = dosSize;
  buf.write('PE\0\0', pe, 'ascii');
  const coff = pe + 4;
  buf.writeUInt16LE(isPe32Plus ? 0x8664 : 0x014c, coff); // machine
  buf.writeUInt16LE(2, coff + 2); // sections
  buf.writeUInt32LE(Math.floor(Date.now() / 1000) & 0xfffffffe, coff + 4); // timestamp (even)
  buf.writeUInt16LE(optSize, coff + 16);
  buf.writeUInt16LE(0x2002, coff + 18); // EXECUTABLE_IMAGE | DLL

  // --- Optional header ---
  const opt = coff + 20;
  buf.writeUInt16LE(isPe32Plus ? 0x20b : 0x10b, opt);
  buf.writeUInt8(14, opt + 2); // linker major
  buf.writeUInt8(0, opt + 3);
  buf.writeUInt32LE(textRaw.length, opt + 4); // SizeOfCode
  buf.writeUInt32LE(rsrcRawSize, opt + 8); // SizeOfInitializedData
  buf.writeUInt32LE(0, opt + 12);
  buf.writeUInt32LE(0, opt + 16); // entry point
  buf.writeUInt32LE(textRva, opt + 20); // BaseOfCode
  let p = opt + 24;
  if (isPe32Plus) {
    buf.writeBigUInt64LE(0x180000000n, p);
    p += 8;
  } else {
    buf.writeUInt32LE(textRva, p); // BaseOfData
    buf.writeUInt32LE(0x10000000, p + 4); // ImageBase
    p += 8;
  }
  buf.writeUInt32LE(SECTION_ALIGN, p); p += 4;
  buf.writeUInt32LE(FILE_ALIGN, p); p += 4;
  buf.writeUInt16LE(6, p); buf.writeUInt16LE(0, p + 2); p += 4; // OS version
  buf.writeUInt16LE(0, p); buf.writeUInt16LE(0, p + 2); p += 4; // image version
  buf.writeUInt16LE(6, p); buf.writeUInt16LE(0, p + 2); p += 4; // subsystem version
  buf.writeUInt32LE(0, p); p += 4; // win32 version
  buf.writeUInt32LE(imageSize, p); p += 4; // SizeOfImage
  buf.writeUInt32LE(sizeOfHeaders, p); p += 4; // SizeOfHeaders
  buf.writeUInt32LE(0, p); p += 4; // checksum
  buf.writeUInt16LE(2, p); p += 2; // subsystem GUI
  buf.writeUInt16LE(0, p); p += 2; // DllCharacteristics
  const size64 = isPe32Plus ? 8 : 4;
  const writeN = (v) => {
    if (isPe32Plus) buf.writeBigUInt64LE(BigInt(v), p);
    else buf.writeUInt32LE(v, p);
    p += size64;
  };
  writeN(0x100000); writeN(0x1000); writeN(0x100000); writeN(0x1000);
  buf.writeUInt32LE(0, p); p += 4; // loader flags
  buf.writeUInt32LE(16, p); p += 4; // number of RVAs
  // Data directories (zeroed except resources at index 2)
  const dataDir = p;
  buf.writeUInt32LE(rsrcRva, dataDir + 2 * 8);
  buf.writeUInt32LE(rsrcSec.length, dataDir + 2 * 8 + 4);

  // --- Section table ---
  const secTab = opt + optSize;
  const writeSection = (off, name, vsize, vaddr, rawSize, rawPtr, chars) => {
    buf.write(name, off, 'ascii');
    buf.writeUInt32LE(vsize, off + 8);
    buf.writeUInt32LE(vaddr, off + 12);
    buf.writeUInt32LE(rawSize, off + 16);
    buf.writeUInt32LE(rawPtr, off + 20);
    buf.writeUInt32LE(chars, off + 36);
  };
  writeSection(secTab, '.text', textRaw.length, textRva, textRaw.length, textPtr, 0x60000020);
  writeSection(secTab + 40, '.rsrc', rsrcSec.length, rsrcRva, rsrcRawSize, rsrcPtr, 0x40000040);

  // --- Section data ---
  textRaw.copy(buf, textPtr);
  rsrcSec.copy(buf, rsrcPtr);

  // Patch the resource data entry with the real RVA of the version blob.
  buf.writeUInt32LE(rsrcRva + blobOff, rsrcPtr + dataEntryOff);

  // --- Optional import directory (inside .text) ---
  // Lets tests build executables that "import" d3d12.dll / vulkan-1.dll etc.
  // so graphics-API detection can be proven against real PE structures.
  const imports = Array.isArray(opts.imports) ? opts.imports.filter(Boolean) : [];
  if (imports.length) {
    const descCount = imports.length + 1; // + null terminator
    const namesStart = descCount * 20;
    let cursor = namesStart;
    const nameOffsets = imports.map((n) => {
      const off = cursor;
      cursor += Buffer.byteLength(n, 'ascii') + 1;
      return off;
    });
    if (cursor > textRaw.length) throw new Error('too many imports for fixture .text section');
    for (let i = 0; i < imports.length; i++) {
      const d = i * 20;
      textRaw.writeUInt32LE(0, d); // OriginalFirstThunk
      textRaw.writeUInt32LE(0, d + 4); // TimeDateStamp
      textRaw.writeUInt32LE(0, d + 8); // ForwarderChain
      textRaw.writeUInt32LE(textRva + nameOffsets[i], d + 12); // Name RVA
      textRaw.writeUInt32LE(0, d + 16); // FirstThunk
      textRaw.write(imports[i], nameOffsets[i], 'ascii');
    }
    textRaw.copy(buf, textPtr); // re-copy with import data written
    buf.writeUInt32LE(textRva, dataDir + 1 * 8); // import directory RVA
    buf.writeUInt32LE(descCount * 20, dataDir + 1 * 8 + 4);
  }

  return buf;
}

module.exports = { buildPeDll, buildVersionInfo, versionDwords };
