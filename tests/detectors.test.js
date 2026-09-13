'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fsp = require('fs').promises;
const path = require('path');
const { AppEnv } = require('../src/core/env');
const { fakeRunner } = require('./helpers');
const steam = require('../src/core/games/detectors/steam');
const epic = require('../src/core/games/detectors/epic');
const xbox = require('../src/core/games/detectors/xbox');
const gog = require('../src/core/games/detectors/gog');
const folders = require('../src/core/games/detectors/folders');

async function tmp() {
  return fsp.mkdtemp(path.join(require('os').tmpdir(), 'dlss5-det-'));
}

function envFor(platform = 'linux') {
  return new AppEnv({ dataDir: '/tmp/unused-data', platform, runner: fakeRunner(), homeDir: '/tmp/unused-home', env: {} });
}

test('Steam: detects games from fixture library tree', async (t) => {
  const root = await tmp();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const lib1 = path.join(root, 'Steam');
  const lib2 = path.join(root, 'SteamLibrary2');
  await fsp.mkdir(path.join(lib1, 'steamapps', 'common', 'Aurora Protocol'), { recursive: true });
  await fsp.mkdir(path.join(lib2, 'steamapps', 'common', 'Neon Drift'), { recursive: true });
  await fsp.writeFile(path.join(lib1, 'steamapps', 'libraryfolders.vdf'), `"libraryfolders"
{
	"0"
	{
		"path"		"${lib1.replace(/\\/g, '\\\\')}"
	}
	"1"
	{
		"path"		"${lib2.replace(/\\/g, '\\\\')}"
	}
}`);
  await fsp.writeFile(path.join(lib1, 'steamapps', 'appmanifest_111.acf'), `"AppState"
{
	"appid"		"111"
	"name"		"Aurora Protocol"
	"StateFlags"		"4"
	"installdir"		"Aurora Protocol"
	"LauncherExe"		"aurora.exe"
}`);
  await fsp.writeFile(path.join(lib2, 'steamapps', 'appmanifest_222.acf'), `"AppState"
{
	"appid"		"222"
	"name"		"Neon Drift 2"
	"StateFlags"		"4"
	"installdir"		"Neon Drift"
}`);
  // Not-installed game must be skipped.
  await fsp.writeFile(path.join(lib2, 'steamapps', 'appmanifest_333.acf'), `"AppState"
{
	"appid"		"333"
	"name"		"Downloading Game"
	"StateFlags"		"1026"
	"installdir"		"Missing"
}`);

  const games = await steam.detect(envFor(), { roots: [lib1] });
  const names = games.map((g) => g.name).sort();
  assert.deepEqual(names, ['Aurora Protocol', 'Neon Drift 2']);
  const aurora = games.find((g) => g.name === 'Aurora Protocol');
  assert.equal(aurora.provider, 'steam');
  assert.equal(aurora.exeName, 'aurora.exe');
  assert.equal(aurora.id, 'steam-111');
});

test('Epic: detects games from .item manifests and LauncherInstalled.dat', async (t) => {
  const root = await tmp();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const manifests = path.join(root, 'Manifests');
  const install = path.join(root, 'Game1');
  await fsp.mkdir(manifests, { recursive: true });
  await fsp.mkdir(install, { recursive: true });
  await fsp.writeFile(path.join(manifests, 'abc.item'), JSON.stringify({
    AppName: 'abc123', DisplayName: 'Realm of Ash', InstallLocation: install, LaunchExecutable: 'realm.exe',
  }));
  const dat = path.join(root, 'LauncherInstalled.dat');
  const install2 = path.join(root, 'Game2');
  await fsp.mkdir(install2, { recursive: true });
  await fsp.writeFile(dat, JSON.stringify({
    InstallationList: [{ AppName: 'def456', InstallLocation: install2, LaunchExecutable: 'other.exe' }],
  }));

  const games = await epic.detect(envFor('win32'), { roots: [manifests], datFiles: [dat] });
  assert.equal(games.length, 2);
  const realm = games.find((g) => g.name === 'Realm of Ash');
  assert.ok(realm);
  assert.equal(realm.exeName, 'realm.exe');
  assert.equal(realm.id, 'epic-abc123');
});

test('Xbox: detects games via MicrosoftGame.config', async (t) => {
  const root = await tmp();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const content = path.join(root, 'XboxGames', 'Star Fielder (PC)', 'content');
  await fsp.mkdir(content, { recursive: true });
  await fsp.writeFile(path.join(content, 'MicrosoftGame.config'),
    `<Game configversion="1"><ExecutableList><Executable Name="starfielder.exe" TargetDeviceFamily="PC"/></ExecutableList></Game>`);

  const games = await xbox.detect(envFor('win32'), { roots: [path.join(root, 'XboxGames')] });
  assert.equal(games.length, 1);
  assert.equal(games[0].name, 'Star Fielder');
  assert.equal(games[0].exeName, 'starfielder.exe');
  assert.equal(games[0].installDir, content);
});

test('GOG: parses reg query output', async (t) => {
  const root = await tmp();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const gameDir = path.join(root, 'Witcher Like');
  await fsp.mkdir(gameDir, { recursive: true });
  const regOutput = `
HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\GOG.com\\Games\\1207658924
    gameID    REG_SZ    1207658924
    path    REG_SZ    ${gameDir}
    exePath    REG_SZ    ${path.join(gameDir, 'witcherlike.exe')}
`;
  const games = await gog.detect(envFor('win32'), { regOutput });
  assert.equal(games.length, 1);
  assert.equal(games[0].provider, 'gog');
  assert.equal(games[0].name, 'Witcher Like');
  assert.equal(games[0].exeName, 'witcherlike.exe');
  assert.equal(games[0].id, 'gog-1207658924');
});

test('Folders: custom folder scan finds game-like directories only', async (t) => {
  const root = await tmp();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  await fsp.mkdir(path.join(root, 'Games', 'GameA'), { recursive: true });
  await fsp.mkdir(path.join(root, 'Games', 'GameB', 'Binaries'), { recursive: true });
  await fsp.mkdir(path.join(root, 'Documents'), { recursive: true });
  await fsp.writeFile(path.join(root, 'Games', 'GameA', 'a.exe'), 'x');
  await fsp.writeFile(path.join(root, 'Games', 'GameB', 'Binaries', 'b.exe'), 'x');
  await fsp.writeFile(path.join(root, 'Documents', 'notes.txt'), 'not a game');

  const games = await folders.detect(envFor(), { folders: [root], depth: 3 });
  const names = games.map((g) => g.name).sort();
  assert.deepEqual(names, ['GameA', 'GameB']);
  assert.ok(games.every((g) => g.provider === 'folder'));
  // stable ids
  const again = await folders.detect(envFor(), { folders: [root], depth: 3 });
  assert.deepEqual(again.map((g) => g.id).sort(), games.map((g) => g.id).sort());
});
