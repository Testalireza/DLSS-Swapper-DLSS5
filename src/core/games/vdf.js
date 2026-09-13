'use strict';

/**
 * Tiny Valve Data Format (VDF/KeyValues) parser — enough for
 * libraryfolders.vdf and appmanifest_*.acf files.
 *
 * Supports quoted keys/values, nested braces, // comments and escape
 * sequences. Returns plain JS objects.
 */

class VdfParseError extends Error {}

function parseVdf(text) {
  let pos = 0;
  const len = text.length;

  function skipWs() {
    for (;;) {
      while (pos < len && /\s/.test(text[pos])) pos++;
      if (text.startsWith('//', pos)) {
        while (pos < len && text[pos] !== '\n') pos++;
        continue;
      }
      break;
    }
  }

  function readQuoted() {
    // text[pos] === '"'
    pos++;
    let out = '';
    while (pos < len) {
      const ch = text[pos];
      if (ch === '\\' && pos + 1 < len) {
        const next = text[pos + 1];
        const map = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\' };
        out += map[next] !== undefined ? map[next] : next;
        pos += 2;
        continue;
      }
      if (ch === '"') { pos++; return out; }
      out += ch;
      pos++;
    }
    throw new VdfParseError('unterminated quoted string');
  }

  function readToken() {
    let out = '';
    while (pos < len && !/[\s"{}]/.test(text[pos])) { out += text[pos]; pos++; }
    return out;
  }

  function parseObject() {
    const obj = {};
    for (;;) {
      skipWs();
      if (pos >= len) return obj;
      if (text[pos] === '}') { pos++; return obj; }
      const key = text[pos] === '"' ? readQuoted() : readToken();
      if (!key) { pos++; continue; }
      skipWs();
      if (pos < len && text[pos] === '{') {
        pos++;
        const child = parseObject();
        // VDF allows duplicate keys (e.g. multiple "State" entries); keep the
        // last scalar but merge objects into arrays when repeated.
        if (key in obj) {
          const prev = obj[key];
          obj[key] = Array.isArray(prev) ? [...prev, child] : [prev, child];
        } else {
          obj[key] = child;
        }
      } else {
        const value = text[pos] === '"' ? readQuoted() : readToken();
        obj[key] = value;
      }
    }
  }

  const result = parseObject();
  return result;
}

/** libraryfolders.vdf → array of library folder paths (ordered). */
function extractSteamLibraries(vdf) {
  const libs = [];
  const root = vdf.libraryfolders || vdf.LibraryFolders || vdf;
  const entries = root.libraryfolders || root;
  const keys = Object.keys(entries).filter((k) => /^\d+$/.test(k)).map(Number).sort((a, b) => a - b);
  for (const k of keys) {
    const entry = entries[k];
    if (entry && typeof entry === 'object' && entry.path) libs.push(entry.path);
    else if (typeof entry === 'string') libs.push(entry);
  }
  return libs;
}

/** appmanifest .acf → {appId, name, installDir, launcherExe} or null. */
function extractAppInfo(acf) {
  const a = acf.AppState || acf.appstate;
  if (!a) return null;
  return {
    appId: a.appid || null,
    name: a.name || null,
    installDir: a.installdir || null,
    launcherExe: a.LauncherExe || a.launcherexe || null,
    StateFlags: a.StateFlags ? Number(a.StateFlags) : null,
  };
}

module.exports = { parseVdf, extractSteamLibraries, extractAppInfo, VdfParseError };
