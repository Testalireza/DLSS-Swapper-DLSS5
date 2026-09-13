'use strict';

const fsp = require('fs').promises;

/**
 * Line-preserving INI utilities.
 *
 * Golden rule (learned from ReShade users losing presets): we NEVER rewrite a
 * user's INI wholesale. Edits are surgical, line-based, append-only:
 *
 *  - ensureCsvValue: make sure `value` appears in a comma-separated key,
 *    appending to the existing line when present, or adding the key/section
 *    when missing. Existing entries and comments are left byte-identical.
 *  - setIfMissing: add key=value only when the key does not exist yet.
 */

function splitLines(text) {
  return text.split(/\r?\n/);
}

function detectEol(text) {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

function parseSection(line) {
  const m = line.trim().match(/^\[([^\]]+)\]$/);
  return m ? m[1] : null;
}

function parseKeyValue(line) {
  const m = line.match(/^\s*([^=;#][^=]*?)\s*=\s*(.*?)\s*$/);
  if (!m) return null;
  return { key: m[1].trim(), value: m[2] };
}

/** Locate the [section] block; returns {start, end} line indices or null. */
function findSection(lines, section) {
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const s = parseSection(lines[i]);
    if (s && s.toLowerCase() === section.toLowerCase()) { start = i; break; }
  }
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (parseSection(lines[i])) { end = i; break; }
  }
  return { start, end };
}

/** Find a key inside a section block. */
function findKey(lines, block, key) {
  for (let i = block.start + 1; i < block.end; i++) {
    const kv = parseKeyValue(lines[i]);
    if (kv && kv.key.toLowerCase() === key.toLowerCase()) return { index: i, kv };
  }
  return null;
}

/**
 * Ensure `value` is present in a CSV-style key inside [section].
 * @returns {Promise<{changed:boolean, text:string}>}
 */
async function ensureCsvValue(file, section, key, value, { separator = ',' } = {}) {
  const original = await fsp.readFile(file, 'utf8').catch(() => '');
  return ensureCsvValueText(original, section, key, value, { separator });
}

function ensureCsvValueText(text, section, key, value, { separator = ',' } = {}) {
  const eol = detectEol(text || '\n');
  const lines = splitLines(text || '');
  let block = findSection(lines, section);
  if (!block) {
    // Append a new section at the end.
    if (lines.length && lines[lines.length - 1].trim() !== '') lines.push('');
    lines.push(`[${section}]`);
    lines.push(`${key}=${value}`);
    return { changed: true, text: lines.join(eol) };
  }
  const found = findKey(lines, block, key);
  if (!found) {
    // Insert the key at the end of the section, before trailing blank lines.
    let insertAt = block.end;
    while (insertAt - 1 > block.start && lines[insertAt - 1].trim() === '') insertAt--;
    lines.splice(insertAt, 0, `${key}=${value}`);
    return { changed: true, text: lines.join(eol) };
  }
  const parts = found.kv.value.split(separator).map((p) => p.trim()).filter(Boolean);
  if (parts.some((p) => p.toLowerCase() === String(value).toLowerCase())) {
    return { changed: false, text };
  }
  lines[found.index] = `${found.kv.key}=${[...parts, value].join(separator)}`;
  return { changed: true, text: lines.join(eol) };
}

/**
 * Set key=value in [section] only when the key is entirely absent.
 */
function setIfMissingText(text, section, key, value) {
  const eol = detectEol(text || '\n');
  const lines = splitLines(text || '');
  let block = findSection(lines, section);
  if (block) {
    const found = findKey(lines, block, key);
    if (found) return { changed: false, text };
    let insertAt = block.end;
    while (insertAt - 1 > block.start && lines[insertAt - 1].trim() === '') insertAt--;
    lines.splice(insertAt, 0, `${key}=${value}`);
    return { changed: true, text: lines.join(eol) };
  }
  if (lines.length && lines[lines.length - 1].trim() !== '') lines.push('');
  lines.push(`[${section}]`);
  lines.push(`${key}=${value}`);
  return { changed: true, text: lines.join(eol) };
}

async function setIfMissing(file, section, key, value) {
  const original = await fsp.readFile(file, 'utf8').catch(() => '');
  return setIfMissingText(original, section, key, value);
}

/** Read a key's value from an INI file (or null). */
async function readValue(file, section, key) {
  let text;
  try { text = await fsp.readFile(file, 'utf8'); } catch { return null; }
  const lines = splitLines(text);
  const block = findSection(lines, section);
  if (!block) return null;
  const found = findKey(lines, block, key);
  return found ? found.kv.value : null;
}

module.exports = { ensureCsvValue, ensureCsvValueText, setIfMissing, setIfMissingText, readValue, findSection, parseKeyValue };
