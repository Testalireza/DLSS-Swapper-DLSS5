'use strict';

const { compareVersions } = require('../../shared/format');
const { APP } = require('../../shared/constants');

/**
 * Application update check — GitHub Releases based.
 *
 * The architecture is provider-style: `updateRepo` is a setting, so releases
 * can move anywhere on GitHub without code changes. No auto-download: the
 * user is pointed at the release page (a modding tool should never
 * self-replace silently).
 */

async function checkForUpdate({ env, settings, logger, currentVersion = APP.version }) {
  const cfg = await settings.get();
  const repo = cfg.updateRepo || 'Testalireza/DLSS-Swapper-DLSS5';
  const url = `https://api.github.com/repos/${repo}/releases/latest`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': `${APP.name}/${currentVersion}`, Accept: 'application/vnd.github+json' },
    });
    if (res.status === 404) {
      return { ok: true, updateAvailable: false, current: currentVersion, latest: null, message: 'No releases published yet for this repository.' };
    }
    if (!res.ok) {
      return { ok: false, error: `GitHub API responded ${res.status}`, current: currentVersion };
    }
    const rel = await res.json();
    const tag = String(rel.tag_name || '').replace(/^v/i, '');
    const updateAvailable = !!tag && compareVersions(tag, currentVersion) > 0;
    if (logger) await logger.info(`Update check: current ${currentVersion}, latest ${tag || 'none'} → ${updateAvailable ? 'update available' : 'up to date'}`);
    return {
      ok: true,
      updateAvailable,
      current: currentVersion,
      latest: tag ? {
        version: tag,
        name: rel.name || tag,
        url: rel.html_url,
        publishedAt: rel.published_at,
        body: (rel.body || '').slice(0, 2000),
      } : null,
    };
  } catch (err) {
    return { ok: false, error: err.message, current: currentVersion };
  }
}

module.exports = { checkForUpdate };
