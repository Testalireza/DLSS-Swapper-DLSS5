'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { buildPeDll } = require('../src/core/pe/peBuilder');
const { parsePeVersion, parsePeHeaders, parsePeImports, PeParseError } = require('../src/core/pe/peVersion');
const { parseVdf, extractSteamLibraries, extractAppInfo } = require('../src/core/games/vdf');

test('PE: version resource round-trip (x64)', () => {
  const buf = buildPeDll({
    fileVersion: '310.9.1.0',
    productVersion: '310.9.1',
    fileDescription: 'NVIDIA DLSS (fixture)',
    productName: 'DLSS',
    companyName: 'Test Tooling',
    originalFilename: 'nvngx_dlss.dll',
  });
  const headers = parsePeHeaders(buf);
  assert.equal(headers.is64bit, true);
  assert.equal(headers.isDll, true);
  const v = parsePeVersion(buf);
  assert.equal(v.fileVersion, '310.9.1.0');
  assert.equal(v.productVersion, '310.9.1.0');
  assert.equal(v.strings.OriginalFilename, 'nvngx_dlss.dll');
  assert.equal(v.strings.CompanyName, 'Test Tooling');
});

test('PE: version resource round-trip (x86)', () => {
  const buf = buildPeDll({ fileVersion: '2.5.1.0', arch: 'x86', originalFilename: 'old.dll' });
  const headers = parsePeHeaders(buf);
  assert.equal(headers.is64bit, false);
  assert.equal(parsePeVersion(buf).fileVersion, '2.5.1.0');
});

test('PE: imports are parsed (graphics API detection source)', () => {
  const buf = buildPeDll({
    fileVersion: '1.0.0.0',
    imports: ['KERNEL32.dll', 'd3d12.dll', 'dxgi.dll', 'vulkan-1.dll'],
  });
  const imports = parsePeImports(buf);
  assert.ok(imports.includes('d3d12.dll'));
  assert.ok(imports.includes('dxgi.dll'));
  assert.ok(imports.includes('vulkan-1.dll'));
  assert.ok(imports.includes('kernel32.dll'));
});

test('PE: garbage input is rejected cleanly', () => {
  assert.throws(() => parsePeHeaders(Buffer.from('not a pe file at all'.repeat(10))), PeParseError);
  const truncated = buildPeDll({ fileVersion: '1.0.0.0' }).subarray(0, 100);
  assert.throws(() => parsePeVersion(Buffer.from(truncated)), PeParseError);
  assert.deepEqual(parsePeImports(Buffer.from('MZ but nothing else'.padEnd(200, '\0'))), []);
});

test('VDF: libraryfolders.vdf parsing', () => {
  const text = `"libraryfolders"
{
	"0"
	{
		"path"		"C:\\\\Program Files (x86)\\\\Steam"
		"apps"
		{
			"480"		"21320011"
		}
	}
	"1"
	{
		"path"		"D:\\\\Games\\\\SteamLibrary"
	}
}`;
  const vdf = parseVdf(text);
  const libs = extractSteamLibraries(vdf);
  assert.deepEqual(libs, ['C:\\Program Files (x86)\\Steam', 'D:\\Games\\SteamLibrary']);
});

test('VDF: appmanifest parsing', () => {
  const text = `"AppState"
{
	"appid"		"1245620"
	"name"		"ELDEN RING"
	"StateFlags"		"4"
	"installdir"		"ELDEN RING"
	"LauncherExe"		"eldenring.exe"
}`;
  const info = extractAppInfo(parseVdf(text));
  assert.equal(info.appId, '1245620');
  assert.equal(info.name, 'ELDEN RING');
  assert.equal(info.installDir, 'ELDEN RING');
  assert.equal(info.launcherExe, 'eldenring.exe');
  assert.equal(info.StateFlags, 4);
});

test('VDF: comments and escapes', () => {
  const vdf = parseVdf(`// comment\n"root"\n{\n\t"key" "va\\"lue" // trailing\n}\n`);
  assert.equal(vdf.root.key, 'va"lue');
});
