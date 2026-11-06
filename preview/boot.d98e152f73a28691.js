/* Preview loading UI. File percentages describe download only, never engine/scene work. */
(function () {
  'use strict';
  const settings = window.RTS_PREVIEW_SETTINGS;
  const config = settings.config;
  const t0 = performance.now();
  const debug = new URLSearchParams(location.search).get('loaddebug') === '1';
  const el = id => document.getElementById(id);
  const events = [];
  const files = {};
  const marks = {};
  const notes = [];
  let failed = false, finished = false, started = false, sceneReady = false;
  let previousBeat = t0, maxBeatGap = 0, sceneLog = '';
  let debugPanel = null;
  let timer;

  function event(name, detail = {}) {
    const ms = Math.round(performance.now() - t0);
    if (name === 'download-start') {
      files[detail.file] = {loaded: 0, total: detail.total || 0, done: false};
    } else if (name === 'download-progress') {
      files[detail.file] = {...files[detail.file], ...detail};
      return; // Do not retain a log entry or update the DOM for every network chunk.
    } else if (name === 'download-end') {
      if (files[detail.file]) files[detail.file].done = true;
    }
    if (marks[name] === undefined) marks[name] = ms;
    events.push({phase: name, ms, ...detail});
    if (name === 'scene-ready') sceneReady = true;
    if (debug) console.log('[preview-load]', name, ms, detail);
  }

  function report() {
    const transfers = performance.getEntriesByType ? performance.getEntriesByType('resource').filter(r => /\.(wasm|pck|js)(?:\?|$)/.test(r.name)).map(r => ({file: r.name.split('/').pop(), startMs: Math.round(r.startTime), durationMs: Math.round(r.duration), transferBytes: r.transferSize, encodedBodyBytes: r.encodedBodySize, decodedBodyBytes: r.decodedBodySize})) : [];
    return {build: settings.build, elapsedMs: Math.round(performance.now() - t0), finished, failed, marks: {...marks}, files, maxHeartbeatGapMs: Math.round(maxBeatGap), sceneLog, notes: [...notes], events: [...events], transfers};
  }

  window.RTSLoad = {event, report};

  function downloadSummary() {
    const states = Object.values(files);
    const total = Object.values(config.fileSizes).reduce((a, b) => a + b, 0);
    const loaded = states.reduce((a, f) => a + f.loaded, 0);
    return {states, total, loaded, done: states.length >= Object.keys(config.fileSizes).length && states.every(f => f.done)};
  }

  function details() {
    const r = report();
    return 'Build: ' + r.build + '\n' +
      events.map(e => (e.ms / 1000).toFixed(1) + 's  ' + e.phase + (e.file ? '  ' + e.file : '')).join('\n') +
      '\nDecoded file data: ' + (downloadSummary().loaded / 1e6).toFixed(1) + ' MB (not compressed network bytes)' +
      '\nLongest UI heartbeat gap: ' + (maxBeatGap / 1000).toFixed(1) + 's' +
      (sceneLog ? '\n' + sceneLog : '') + (notes.length ? '\n' + notes.join('\n') : '');
  }

  function render() {
    if (finished) return;
    const now = performance.now();
    maxBeatGap = Math.max(maxBeatGap, now - previousBeat);
    previousBeat = now;
    const seconds = Math.floor((now - t0) / 1000);
    el('status-elapsed').textContent = seconds + (seconds === 1 ? ' second elapsed' : ' seconds elapsed');
    const d = downloadSummary();
    if (!failed) {
      if (!marks['engine-script-ready']) {
        el('status-phase').textContent = 'Downloading the game loader…';
      } else if (!d.done) {
        const percent = d.total && d.loaded > 0 ? Math.min(100, Math.floor(100 * d.loaded / d.total)) : null;
        el('status-phase').textContent = 'Downloading game files' + (percent === null ? '…' : ' — ' + percent + '%');
        if (percent !== null) { el('status-progress').max = d.total; el('status-progress').value = d.loaded; }
      } else if (!marks['wasm-ready']) {
        el('status-phase').textContent = 'Files downloaded. Preparing the game engine…';
        el('status-progress').removeAttribute('value');
      } else if (!marks['scene-start']) {
        el('status-phase').textContent = 'Starting the game engine…';
        el('status-progress').removeAttribute('value');
      } else {
        el('status-phase').textContent = sceneReady ? 'Map ready. Opening the game…' : 'Building the map…';
        el('status-progress').removeAttribute('value');
      }
      if (seconds >= 30) {
        el('status-hint').textContent = 'Still working. You can wait, or retry loading. Loading details show which step is taking time.';
        el('status-retry').hidden = false;
      }
    }
    el('status-diagnostics').textContent = details();
  }

  function fail(error) {
    if (failed || finished) return;
    failed = true;
    event('failed', {message: error && error.message ? error.message : String(error)});
    console.error('[preview-load]', error);
    el('status-phase').textContent = 'The game could not finish loading.';
    el('status-notice').textContent = error && error.message ? error.message : String(error);
    el('status-retry').hidden = false;
    el('status-progress').hidden = true;
    render();
    clearInterval(timer);
  }

  async function finish() {
    if (failed || finished) return;
    // Give the first scene a rendering opportunity; this is not a measured paint timestamp.
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    if (failed || finished) return;
    event('first-render-opportunity');
    finished = true;
    clearInterval(timer);
    el('status').remove();
    if (debug) {
      debugPanel = document.createElement('details');
      debugPanel.id = 'loaddebug';
      const summary = document.createElement('summary');
      summary.textContent = 'Load ' + ((performance.now() - t0) / 1000).toFixed(1) + 's · details';
      const pre = document.createElement('pre');
      pre.textContent = details();
      debugPanel.appendChild(summary); debugPanel.appendChild(pre);
      document.body.appendChild(debugPanel);
    }
    console.log('[preview-load] complete', report());
  }

  function printed(...args) {
    console.log(...args);
    const text = args.join(' ');
    if (text.startsWith('[load]')) {
      sceneLog = text;
      event('scene-ready', {message: text});
      render();
      if (started) finish();
    }
  }

  async function start() {
    try {
      event('engine-script-start');
      await new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = settings.engineScript;
        script.onload = resolve;
        script.onerror = () => reject(new Error('The game loader could not download. Please retry.'));
        document.body.appendChild(script);
      });
      event('engine-script-ready');
      const missing = Engine.getMissingFeatures({threads: false});
      if (missing.length) throw new Error(missing.join('\n'));
      const engine = new Engine(config);
      await engine.startGame({onPrint: printed, onPrintError: (...args) => console.error(...args)});
      started = true;
      event('game-start-returned');
      render();
      if (sceneReady) finish();
      else {
        // The game currently emits [load]. Keep compatibility with future builds
        // that remove diagnostics, but never claim a measured scene-ready time.
        setTimeout(() => {
          if (!sceneReady && !failed && !finished) {
            notes.push('Scene-ready console marker absent; showing the started engine.');
            event('scene-marker-fallback'); finish();
          }
        }, 2000);
      }
    } catch (error) { fail(error); }
  }

  document.addEventListener('visibilitychange', () => event(document.hidden ? 'tab-hidden' : 'tab-visible'));
  if (debug) el('status-details').open = true;
  timer = setInterval(render, 250);
  render(); start();
}());
