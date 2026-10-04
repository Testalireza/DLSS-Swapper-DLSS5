'use strict';

/**
 * Batch apply — apply one DLSS profile to several games in a single run.
 *
 * A profile is { runtimeVersion?, injectionId?, method } — a DLSS runtime
 * version to swap in, a DLSS 5 injection package to install, or both.
 * Profiles can be saved by name (settings.dlssProfiles) and reused.
 *
 * Games are processed one at a time through the exact same IPC operations
 * the single-game pages use (backup → install → verify → rollback), so the
 * safety model is unchanged. Games that need a conflict confirmation are
 * skipped unless the user opted in up front.
 */
(function () {
  const { el, clear, badge, btn, progressBar, stepList } = window.UI;
  const { IPC, makeId } = window.DLSS5Shared;
  const api = window.UI.api;

  const NO_RUNTIME = '';
  const NO_INJECTION = '';

  function methodLabel(m) {
    return m === 'reshade' ? 'ReShade' : 'OptiScaler';
  }

  function describeProfile(p, packages) {
    const parts = [];
    if (p.runtimeVersion) parts.push(`DLSS runtime ${p.runtimeVersion}`);
    if (p.injectionId) {
      const pkg = packages.find((x) => x.id === p.injectionId);
      parts.push(`DLSS 5 injection “${pkg ? pkg.name : p.injectionId}” via ${methodLabel(p.method)}`);
    }
    return parts.join(' + ') || 'nothing';
  }

  async function saveProfiles(profiles) {
    await api.invoke(IPC.SETTINGS_SET, { patch: { dlssProfiles: profiles } });
    await window.UI.reloadSettings();
  }

  /**
   * Profile picker dialog. Resolves { profile, skipConflictWarnings } or null.
   */
  async function chooseProfile(games, runtimes, packages) {
    const settings = window.UI.state.settings || {};
    let profiles = Array.isArray(settings.dlssProfiles) ? settings.dlssProfiles.slice() : [];

    const profileSelect = el('select', { style: 'width:100%', 'aria-label': 'Saved profile' });
    const runtimeSelect = el('select', { style: 'width:100%', 'aria-label': 'DLSS runtime version' });
    const injectionSelect = el('select', { style: 'width:100%', 'aria-label': 'DLSS 5 injection package' });
    const methodSelect = el('select', { style: 'width:100%', 'aria-label': 'Injection method' }, [
      el('option', { value: 'optiscaler' }, 'OptiScaler'),
      el('option', { value: 'reshade' }, 'ReShade'),
    ]);
    const nameInput = el('input', { type: 'text', placeholder: 'Profile name, e.g. “Latest DLSS + DLSS 5”', style: 'flex:1' });
    const conflictToggle = el('input', { type: 'checkbox' });
    const summary = el('div.batch-summary');

    runtimeSelect.appendChild(el('option', { value: NO_RUNTIME }, 'Don’t change the runtime'));
    for (const rt of runtimes.slice().reverse()) {
      const opt = el('option', { value: rt.version },
        `${rt.version}${rt.available ? (rt.complete ? '' : ' (incomplete)') : ' (not in library)'}`);
      opt.disabled = !rt.complete;
      runtimeSelect.appendChild(opt);
    }

    injectionSelect.appendChild(el('option', { value: NO_INJECTION }, 'No DLSS 5 injection'));
    for (const pkg of packages) injectionSelect.appendChild(el('option', { value: pkg.id }, pkg.name));

    const renderProfileOptions = (selectedId) => {
      clear(profileSelect);
      profileSelect.appendChild(el('option', { value: '' }, profiles.length ? 'Custom (choose below)' : 'Custom — no saved profiles yet'));
      for (const p of profiles) {
        profileSelect.appendChild(el('option', { value: p.id, selected: p.id === selectedId || undefined }, p.name));
      }
    };

    const current = () => ({
      runtimeVersion: runtimeSelect.value || null,
      injectionId: injectionSelect.value || null,
      method: methodSelect.value,
    });

    const refresh = () => {
      const p = current();
      methodSelect.disabled = !p.injectionId;
      deleteBtn.disabled = !profileSelect.value;
      clear(summary);
      summary.appendChild(el('div', [el('strong', 'Will apply: '), describeProfile(p, packages)]));
      if (p.injectionId) {
        const pkg = packages.find((x) => x.id === p.injectionId);
        if (pkg && !(pkg.methods || []).includes(p.method)) {
          summary.appendChild(el('div.banner.banner-warning', { style: 'margin-top:8px' }, [
            el('div', '⚠'),
            el('div.banner-body', `“${pkg.name}” does not declare support for ${methodLabel(p.method)} — those installs will fail with a method mismatch.`),
          ]));
        }
      }
      applyBtnState();
    };

    const loadProfile = (id) => {
      const p = profiles.find((x) => x.id === id);
      if (!p) { refresh(); return; }
      const hasRuntime = p.runtimeVersion && Array.from(runtimeSelect.options).some((o) => o.value === p.runtimeVersion && !o.disabled);
      const hasPkg = p.injectionId && packages.some((x) => x.id === p.injectionId);
      runtimeSelect.value = hasRuntime ? p.runtimeVersion : NO_RUNTIME;
      injectionSelect.value = hasPkg ? p.injectionId : NO_INJECTION;
      methodSelect.value = p.method === 'reshade' ? 'reshade' : 'optiscaler';
      nameInput.value = p.name;
      if ((p.runtimeVersion && !hasRuntime) || (p.injectionId && !hasPkg)) {
        window.UI.toast.warning('Profile partly unavailable',
          `${p.name}: ${p.runtimeVersion && !hasRuntime ? `runtime ${p.runtimeVersion} is not in your library` : ''}${p.runtimeVersion && !hasRuntime && p.injectionId && !hasPkg ? '; ' : ''}${p.injectionId && !hasPkg ? 'its injection package was deleted' : ''}.`);
      }
      refresh();
    };

    const saveBtn = btn('💾 Save profile', {
      size: 'sm',
      onclick: async () => {
        const name = nameInput.value.trim();
        const p = current();
        if (!name) { window.UI.toast.warning('Name required', 'Give the profile a name before saving it.'); nameInput.focus(); return; }
        if (!p.runtimeVersion && !p.injectionId) { window.UI.toast.warning('Empty profile', 'Choose a runtime version and/or an injection package first.'); return; }
        const existing = profiles.find((x) => x.name.toLowerCase() === name.toLowerCase());
        const saved = { id: existing ? existing.id : `profile-${makeId()}`, name, ...p };
        profiles = existing ? profiles.map((x) => (x.id === existing.id ? saved : x)) : [...profiles, saved];
        await saveProfiles(profiles);
        renderProfileOptions(saved.id);
        refresh();
        window.UI.toast.success(existing ? 'Profile updated' : 'Profile saved', `“${name}” — ${describeProfile(saved, packages)}`);
      },
    });
    const deleteBtn = btn('🗑', {
      size: 'sm', kind: 'ghost', tip: 'Delete the selected saved profile', ariaLabel: 'Delete saved profile',
      onclick: async () => {
        const p = profiles.find((x) => x.id === profileSelect.value);
        if (!p) return;
        profiles = profiles.filter((x) => x.id !== p.id);
        await saveProfiles(profiles);
        renderProfileOptions('');
        nameInput.value = '';
        refresh();
        window.UI.toast.info('Profile deleted', `“${p.name}” removed.`);
      },
    });

    profileSelect.addEventListener('change', () => loadProfile(profileSelect.value));
    for (const s of [runtimeSelect, injectionSelect, methodSelect]) {
      s.addEventListener('change', () => { profileSelect.value = ''; refresh(); });
    }

    const field = (label, control, desc) => el('div', { style: 'margin-bottom:12px' }, [
      el('label.field-label', { style: 'display:block; margin-bottom:4px' }, label),
      control,
      desc ? el('div.field-desc', { style: 'margin-top:4px' }, desc) : null,
    ]);

    renderProfileOptions('');
    // Default to the newest complete runtime so the common case is one click.
    const latest = runtimes.filter((r) => r.complete).pop();
    if (latest) runtimeSelect.value = latest.version;

    const anyRuntime = runtimes.some((r) => r.complete);
    const body = [
      el('p', ['Apply the same DLSS profile to ', el('strong', `${games.length} game(s)`),
        '. Each game is backed up, installed and verified one after another — a failure in one game is rolled back and does not stop the others.']),
      el('div.chip-list', { style: 'margin-bottom:14px' }, games.map((g) => el('span.chip', g.name))),
      field('Saved profile', el('div', { style: 'display:flex; gap:6px' }, [profileSelect, deleteBtn])),
      field('DLSS runtime version', runtimeSelect,
        anyRuntime ? null : 'No complete runtime packages in your library yet — import one on the Runtimes page.'),
      el('div', { style: 'display:grid; grid-template-columns: 2fr 1fr; gap:10px' }, [
        field('DLSS 5 injection package', injectionSelect,
          packages.length ? null : 'No injection packages imported — see DLSS 5 Neural Rendering.'),
        field('Method', methodSelect),
      ]),
      field('Save these choices as a profile', el('div', { style: 'display:flex; gap:6px' }, [nameInput, saveBtn])),
      el('label', { style: 'display:flex; gap:8px; align-items:flex-start; font-size:12.5px; margin:4px 0 12px' }, [
        conflictToggle,
        el('span', [el('strong', 'Continue past conflict warnings. '),
          'When off, games with proxy DLLs or other modding tools are skipped so you can review them one by one.']),
      ]),
      summary,
    ];

    let applyButton = null;
    const applyBtnState = () => {
      if (!applyButton) return;
      const p = current();
      applyButton.disabled = !p.runtimeVersion && !p.injectionId;
    };

    const dialogPromise = window.UI.dialogs.open({
      icon: '🎛️',
      title: `Apply DLSS profile to ${games.length} game(s)`,
      wide: true,
      body,
      buttons: [
        { label: 'Cancel', value: false },
        { label: `⚡ Apply to ${games.length} game(s)`, value: true, kind: 'primary', autofocus: true },
      ],
    });
    // The dialog API has no button handles; grab the primary one from the DOM.
    const backdrops = document.querySelectorAll('#modal-root .modal-backdrop');
    const last = backdrops[backdrops.length - 1];
    applyButton = last ? last.querySelector('.modal-footer .btn-primary') : null;
    refresh();

    const ok = await dialogPromise;
    if (!ok) return null;
    const profile = current();
    if (!profile.runtimeVersion && !profile.injectionId) return null;
    return { profile, skipConflictWarnings: conflictToggle.checked };
  }

  /** GPU gate for injections — asked once for the whole batch. */
  async function passGpuGate() {
    const settings = window.UI.state.settings || {};
    const gpu = window.UI.state.gpu || await window.UI.loadGpu();
    const compat = gpu && gpu.compatibility;
    if (!compat || compat.status === 'supported' || (settings.gpuCompatibilityOverride && settings.advancedMode)) return true;
    return window.UI.dialogs.confirm('GPU compatibility not verified', [
      el('div', compat.headline || 'Compatibility could not be fully verified.'),
      el('p', 'DLSS 5 Neural Rendering targets NVIDIA RTX 20/30/40/50 series GPUs. Installing on unverified hardware may not work and can cause crashes.'),
    ], { okLabel: 'Install anyway (this batch)', icon: '⚠️' });
  }

  function statusBadge(status, detail) {
    switch (status) {
      case 'running': return badge('working…', 'info');
      case 'done': return badge('✓ done', 'success', detail);
      case 'failed': return badge('✕ failed', 'danger', detail);
      case 'rolled-back': return badge('rolled back', 'warning', detail);
      case 'skipped': return badge('skipped', 'warning', detail);
      default: return badge('queued');
    }
  }

  /**
   * Run one operation and normalise the outcome to
   * { status: 'done'|'failed'|'rolled-back'|'skipped', message }.
   */
  async function runOp(channel, payload) {
    let res;
    try { res = await api.invoke(channel, payload); } catch (err) { res = { ok: false, error: err.message }; }
    if (res && res.ok) return { status: 'done', res };
    if (res && res.code === 'needs-conflict-confirmation') {
      const files = (res.conflicts || []).map((c) => c.file || c.type).filter(Boolean);
      return { status: 'skipped', message: `conflicts need review${files.length ? ` (${files.join(', ')})` : ''}` };
    }
    if (res && res.rolledBack) return { status: 'rolled-back', message: res.error || 'verification failed — original files restored' };
    return { status: 'failed', message: (res && (res.error || (res.errors || []).join('; '))) || 'unknown error' };
  }

  async function runBatch(games, { profile, skipConflictWarnings }) {
    const settings = window.UI.state.settings || {};
    const rows = new Map();
    const list = el('div.batch-list');
    for (const g of games) {
      const status = el('span.batch-status', statusBadge('queued'));
      const detail = el('div.batch-detail');
      const row = el('div.batch-row', [el('div.batch-row-head', [el('strong', g.name), el('span.spacer'), status]), detail]);
      rows.set(g.id, { row, status, detail });
      list.appendChild(row);
    }
    const overall = progressBar(0);
    const steps = stepList([]);
    const currentLabel = el('div.batch-current', 'Starting…');

    const dialogPromise = window.UI.dialogs.open({
      icon: '⚙️',
      title: `Applying profile to ${games.length} game(s)`,
      wide: true,
      dismissable: false,
      body: [
        el('div', { style: 'font-size:12.5px; color:var(--text-secondary); margin-bottom:8px' }, describeProfile(profile, window.UI.batchApply._packages || [])),
        overall.node,
        currentLabel,
        steps.node,
        list,
      ],
      buttons: [{ label: 'Close', value: 'closed', kind: 'primary', disabled: true }],
    });

    const results = [];
    let i = 0;
    for (const g of games) {
      const r = rows.get(g.id);
      clear(r.status); r.status.appendChild(statusBadge('running'));
      r.row.classList.add('running');
      r.row.scrollIntoView && r.row.scrollIntoView({ block: 'nearest' });
      const outcomes = [];

      const track = (label, key) => {
        currentLabel.textContent = `${g.name} — ${label}`;
        steps.render([]);
        return window.UI.bus.on(key, (data) => { if (data.steps) steps.render(data.steps); });
      };

      if (profile.runtimeVersion) {
        const off = track(`installing runtime ${profile.runtimeVersion}`, `progress:runtime:${g.id}`);
        const o = await runOp(IPC.OPS_INSTALL_RUNTIME, {
          gameId: g.id, version: profile.runtimeVersion,
          force: !!settings.advancedMode && !!settings.forceInstall, skipConflictWarnings,
        });
        off();
        outcomes.push({ what: `Runtime ${profile.runtimeVersion}`, ...o,
          message: o.status === 'done' ? `${o.res.fromVersion || 'none'} → ${o.res.toVersion}` : o.message });
      }

      const runtimeOk = !outcomes.length || outcomes[0].status === 'done';
      if (profile.injectionId && runtimeOk) {
        const off = track(`installing DLSS 5 injection (${methodLabel(profile.method)})`, `progress:injection:${g.id}`);
        const o = await runOp(IPC.INJECTIONS_INSTALL, {
          gameId: g.id, injectionId: profile.injectionId, method: profile.method, force: false, skipConflictWarnings,
        });
        off();
        outcomes.push({ what: `DLSS 5 (${methodLabel(profile.method)})`, ...o, message: o.status === 'done' ? 'installed' : o.message });
      } else if (profile.injectionId) {
        outcomes.push({ what: 'DLSS 5 injection', status: 'skipped', message: 'not attempted because the runtime step did not complete' });
      }

      const worst = ['failed', 'rolled-back', 'skipped', 'done'].find((s) => outcomes.some((o) => o.status === s)) || 'done';
      window.UI.state.analysisCache[g.id] = null;
      r.row.classList.remove('running');
      clear(r.status); r.status.appendChild(statusBadge(worst));
      clear(r.detail);
      for (const o of outcomes) r.detail.appendChild(el('div', [`${o.what}: `, el('span', { class: `batch-${o.status}` }, o.message || o.status)]));
      results.push({ game: g, status: worst, outcomes });
      overall.set(Math.round((++i / games.length) * 100));
    }

    steps.render([]);
    const count = (s) => results.filter((x) => x.status === s).length;
    currentLabel.textContent = `Finished — ${count('done')} succeeded, ${count('skipped')} skipped, ${count('failed') + count('rolled-back')} failed.`;
    const backdrops = document.querySelectorAll('#modal-root .modal-backdrop');
    const last = backdrops[backdrops.length - 1];
    if (last) last.querySelectorAll('.modal-footer .btn').forEach((b) => { b.disabled = false; b.focus(); });
    await dialogPromise;
    return results;
  }

  /**
   * Entry point: pick a profile for the given game ids, then apply it.
   * Resolves with the per-game results, or null when cancelled.
   */
  async function open(gameIds) {
    const games = window.UI.state.games.filter((g) => gameIds.includes(g.id));
    if (!games.length) return null;

    const [runtimesRes, packages] = await Promise.all([
      window.UI.state.runtimes || window.UI.loadRuntimes(),
      api.invoke(IPC.INJECTIONS_LIST),
    ]);
    const runtimes = (runtimesRes && runtimesRes.runtimes) || [];
    const pkgs = Array.isArray(packages) ? packages : [];
    window.UI.batchApply._packages = pkgs;

    const choice = await chooseProfile(games, runtimes, pkgs);
    if (!choice) return null;
    if (choice.profile.injectionId && !(await passGpuGate())) return null;

    const results = await runBatch(games, choice);
    const ok = results.filter((r) => r.status === 'done').length;
    if (ok === results.length) window.UI.toast.success('Profile applied', `${ok} game(s) updated and verified.`);
    else window.UI.toast.warning('Profile partly applied', `${ok} of ${results.length} game(s) updated. See History for details.`);
    return results;
  }

  window.UI.batchApply = { open, describeProfile, _packages: [] };
})();
