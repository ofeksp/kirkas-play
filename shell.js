const $ = (id) => document.getElementById(id);
const canvas = $('kirkas-canvas');
const host = $('canvas-host');
const playArea = $('play-area');
const settings = $('settings');
let game;
let ready = false;
let started = false;
let forceWide = false;
let lastLayout = '';
let pendingImport;
let reduced = false;
let muted = false;
let pendingPreferences;
const audioContexts = new Set();

// Bevy creates its own audio context. Preserve the constructor and capture those
// contexts so a later, trusted tap can resume them on Safari as well as Chromium.
for (const name of ['AudioContext', 'webkitAudioContext']) {
  const Original = window[name];
  if (!Original) continue;
  try {
    window[name] = new Proxy(Original, {
      construct(target, args) {
        const context = Reflect.construct(target, args);
        audioContexts.add(context);
        return context;
      },
    });
  } catch { /* Sound can still be unavailable; the game remains playable. */ }
}

async function unlockAudio() {
  const results = await Promise.allSettled([...audioContexts].map((context) => context.resume()));
  const failed = results.some((result) => result.status === 'rejected');
  if (failed) setSettingsStatus('Sound is unavailable right now. You can keep playing and try Enable sound again.', true);
  return !failed;
}

function key(code, value) {
  if (!ready || !started) return;
  if (settings.open && !['KeyM', 'KeyN'].includes(code)) return;
  canvas.focus({ preventScroll: true });
  canvas.dispatchEvent(new KeyboardEvent('keydown', { code, key: value, bubbles: true, cancelable: true }));
  // Keep the press alive through a render frame; release before the next action.
  return new Promise((resolve) => setTimeout(() => {
    canvas.dispatchEvent(new KeyboardEvent('keyup', { code, key: value, bubbles: true, cancelable: true }));
    resolve();
  }, 90));
}
let inputQueue = Promise.resolve();
let queuedInputs = 0;
let inputGeneration = 0;
function enqueueKey(code, value) {
  // Do not build an unbounded delayed sequence while a player rapidly taps.
  if (queuedInputs >= 4) return;
  queuedInputs++;
  const generation = inputGeneration;
  inputQueue = inputQueue.then(() => generation === inputGeneration ? key(code, value) : undefined).finally(() => { queuedInputs--; });
}
document.querySelectorAll('[data-code]').forEach((button) => {
  button.addEventListener('click', () => {
    unlockAudio();
    enqueueKey(button.dataset.code, button.dataset.key);
  });
});
// Browser arrow scrolling must not compete with the game's keyboard controls.
canvas.addEventListener('keydown', (event) => {
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(event.key)) event.preventDefault();
});

function resizeStage() {
  if (!ready) return;
  syncPreferences();
  const availableWidth = $('stage-scroll').clientWidth;
  const mobile = availableWidth < 700;
  const wide = (forceWide && availableWidth < 1120) || (mobile && window.kirkasLayout?.wide === true);
  const width = wide ? 1120 : availableWidth;
  const height = wide ? 820 : mobile ? Math.round(1750 * width / 480) : Math.max(760, Math.min(1100, window.innerHeight - 220));
  const layout = `${width}:${height}:${wide}`;
  if (layout === lastLayout) return;
  lastLayout = layout;
  resetTouch();
  host.style.width = `${width}px`;
  host.style.height = `${height}px`;
  $('layout-note').hidden = !wide;
  $('stage-scroll').setAttribute('aria-label', wide ? 'Wide game viewport; scroll sideways to reach all choices' : 'Game viewport; scroll down to reach all choices');
  if (!wide) $('stage-scroll').scrollLeft = 0;
}
window.addEventListener('resize', resizeStage);
window.visualViewport?.addEventListener('resize', resizeStage);
setInterval(resizeStage, 150);
$('wide').addEventListener('click', () => {
  forceWide = !forceWide;
  $('wide').setAttribute('aria-pressed', String(forceWide));
  resizeStage();
});

function inside(point, rectangle) {
  return rectangle && point.x >= rectangle.x && point.y >= rectangle.y
    && point.x <= rectangle.x + rectangle.width && point.y <= rectangle.y + rectangle.height;
}
function canvasPoint(touch) {
  const bounds = canvas.getBoundingClientRect();
  return { x: touch.clientX - bounds.left, y: touch.clientY - bounds.top };
}
let touchGesture;
let dragTouch;
let scrollTouch;
function resetTouch() {
  touchGesture = undefined;
  dragTouch = undefined;
  scrollTouch = undefined;
}
canvas.addEventListener('touchstart', (event) => {
  unlockAudio();
  if (!started || settings.open || event.touches.length !== 1) { resetTouch(); return; }
  const point = canvasPoint(event.touches[0]);
  const board = window.kirkasBoardRect;
  const swipe = board?.active && inside(point, board);
  const drag = !swipe && window.kirkasTouchRegions?.some((region) => inside(point, region));
  const scroll = !swipe && !drag && window.kirkasScrollRegions?.some((region) => inside(point, region));
  // Bevy handles inventory drags and scrolling inside clipped menu regions.
  // Everywhere else retains native scrolling of the surrounding page.
  if (swipe || drag || scroll) event.preventDefault();
  touchGesture = swipe ? { ...point, id: event.touches[0].identifier } : undefined;
  dragTouch = drag ? event.touches[0].identifier : undefined;
  scrollTouch = scroll ? event.touches[0].identifier : undefined;
}, { passive: false });
canvas.addEventListener('touchmove', (event) => {
  if (settings.open || event.touches.length !== 1) { resetTouch(); return; }
  if (touchGesture || dragTouch !== undefined || scrollTouch !== undefined) event.preventDefault();
}, { passive: false });
canvas.addEventListener('touchend', (event) => {
  if ([...event.changedTouches].some((touch) => touch.identifier === dragTouch)) dragTouch = undefined;
  if ([...event.changedTouches].some((touch) => touch.identifier === scrollTouch)) scrollTouch = undefined;
  if (!touchGesture) return;
  const gesture = touchGesture;
  touchGesture = undefined;
  const touch = [...event.changedTouches].find((item) => item.identifier === gesture.id);
  if (!touch || !window.kirkasBoardRect?.active) return;
  const point = canvasPoint(touch);
  const dx = point.x - gesture.x;
  const dy = point.y - gesture.y;
  const major = Math.max(Math.abs(dx), Math.abs(dy));
  const minor = Math.min(Math.abs(dx), Math.abs(dy));
  if (major < 28 || major < minor * 1.25) return;
  const direction = Math.abs(dx) > Math.abs(dy) ? dx > 0 ? 'ArrowRight' : 'ArrowLeft' : dy > 0 ? 'ArrowDown' : 'ArrowUp';
  enqueueKey(direction, direction);
});
canvas.addEventListener('touchcancel', resetTouch);
canvas.addEventListener('pointerdown', (event) => { if (event.isTrusted) unlockAudio(); });

function setSettingsStatus(message, error = false) {
  $('settings-status').textContent = message;
  $('settings-status').classList.toggle('error', error);
}
function requestPreferences() {
  pendingPreferences = { muted, reduced };
  game.kirkas_set_preferences(muted, reduced);
}
function syncPreferences() {
  if (!started || !window.kirkasPreferences) return;
  if (pendingPreferences) {
    if (window.kirkasPreferences.muted !== pendingPreferences.muted ||
        window.kirkasPreferences.reduced !== pendingPreferences.reduced) return;
    pendingPreferences = undefined;
  }
  muted = window.kirkasPreferences.muted === true;
  reduced = window.kirkasPreferences.reduced === true;
  $('audio').textContent = muted ? 'Enable sound' : 'Mute sound';
  $('audio').setAttribute('aria-pressed', String(muted));
  $('motion').setAttribute('aria-pressed', String(reduced));
}
function updateSaveStatus(detail = window.kirkasSaveStatus) {
  if (!detail) return;
  $('save-status').textContent = detail.message;
  $('save-status').className = `save-status ${detail.status}`;
}
window.addEventListener('kirkas-save-status', (event) => updateSaveStatus(event.detail));
$('menu-open').addEventListener('click', () => {
  inputGeneration++;
  resetTouch();
  settings.showModal();
});
$('menu-close').addEventListener('click', () => settings.close());
settings.addEventListener('close', () => {
  pendingImport = undefined;
  $('import-confirm').hidden = true;
  if (started) canvas.focus({ preventScroll: true });
});
$('audio').addEventListener('click', () => {
  unlockAudio();
  if (!started) return;
  muted = !muted;
  requestPreferences();
  $('audio').textContent = muted ? 'Enable sound' : 'Mute sound';
  $('audio').setAttribute('aria-pressed', String(muted));
});
$('motion').addEventListener('click', () => {
  reduced = !reduced;
  requestPreferences();
  $('motion').setAttribute('aria-pressed', String(reduced));
});
$('export').addEventListener('click', () => {
  try {
    const snapshot = game.kirkas_export_save();
    const blob = new Blob([snapshot], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `kirkas-backup-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    setSettingsStatus('Backup exported. On iPhone, look in Files → Downloads (or your chosen Safari download folder).');
  } catch (error) { setSettingsStatus(String(error), true); }
});
$('import').addEventListener('click', () => { $('import-file').value = ''; $('import-file').click(); });
$('import-file').addEventListener('change', async () => {
  const file = $('import-file').files[0];
  if (!file) return;
  pendingImport = undefined;
  $('import-confirm').hidden = true;
  if (file.size > 2 * 1024 * 1024) { setSettingsStatus('That backup is too large. Choose a Kirkas JSON backup no larger than 2 MiB.', true); return; }
  try {
    pendingImport = await file.text();
    // Schema/version/state validation belongs to Rust and runs before committing.
    JSON.parse(pendingImport);
    $('import-name').textContent = file.name;
    $('import-confirm').hidden = false;
    setSettingsStatus('Choose whether to replace the current run.');
  } catch { pendingImport = undefined; setSettingsStatus('This file is not valid JSON. Your current run is unchanged.', true); }
});
$('import-cancel').addEventListener('click', () => { pendingImport = undefined; $('import-confirm').hidden = true; setSettingsStatus('Kept the current run.'); });
$('import-commit').addEventListener('click', () => {
  if (!pendingImport) return;
  try { game.kirkas_import_save(pendingImport); location.reload(); }
  catch (error) { setSettingsStatus(String(error), true); }
});

async function loadGame() {
  $('start').disabled = true;
  $('loading').hidden = false;
  $('load-error').hidden = true;
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), 180_000);
  try {
    if (!window.WebAssembly) throw new Error('This browser does not support WebAssembly. Try an updated Safari or Chrome.');
    const probe = document.createElement('canvas').getContext('webgl2');
    if (!probe) throw new Error('WebGL 2 is unavailable. Update the browser or try a device with WebGL 2 enabled.');
    probe.getExtension('WEBGL_lose_context')?.loseContext();
    const [module, response] = await Promise.all([import('./kirkas.js'), fetch('./kirkas_bg.wasm', { signal: timeout.signal })]);
    if (!response.ok) throw new Error(`The game download failed (${response.status}). Please reload and try again.`);
    game = module;
    const total = response.headers.has('content-encoding') ? 0 : Number(response.headers.get('content-length'));
    let downloaded = 0;
    let wasmResponse = response;
    if (response.body) {
      const reader = response.body.getReader();
      wasmResponse = new Response(new ReadableStream({
        async pull(controller) {
          try {
            const { done, value } = await reader.read();
            if (done) { controller.close(); $('load-message').textContent = 'Preparing the stage…'; return; }
            downloaded += value.byteLength;
            $('load-message').textContent = `Downloading the game… ${(downloaded / 1048576).toFixed(1)} MB${total ? ` of ${(total / 1048576).toFixed(1)} MB` : ''}`;
            if (total) { $('load-progress').max = total; $('load-progress').value = downloaded; }
            controller.enqueue(value);
          } catch (error) { controller.error(error); }
        },
        cancel(reason) { return reader.cancel(reason); },
      }), { headers: response.headers });
    }
    playArea.hidden = false;
    playArea.style.visibility = 'hidden';
    playArea.style.height = '0';
    playArea.style.overflow = 'hidden';
    playArea.inert = true;
    ready = true;
    resizeStage();
    await game.default({ module_or_path: wasmResponse });
    $('load-message').textContent = 'Preparing the stage…';
    const startTime = performance.now();
    while (!window.kirkasLayout) {
      if (performance.now() - startTime > 45_000) throw new Error('The game did not finish starting. Try reloading or closing other browser tabs.');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    updateSaveStatus();
    $('loading').hidden = true;
    $('start').disabled = false;
    $('start').textContent = 'Enter the big top';
    $('start').focus();
    $('start').onclick = () => {
      unlockAudio();
      started = true;
      $('welcome').hidden = true;
      playArea.style.visibility = '';
      playArea.style.height = '';
      playArea.style.overflow = '';
      playArea.inert = false;
      ['audio', 'motion', 'wide', 'export', 'import'].forEach((id) => { $(id).disabled = false; });
      $('audio').textContent = 'Mute sound';
      if (matchMedia('(prefers-reduced-motion: reduce)').matches && !window.kirkasPreferences?.reduced) {
        reduced = true;
        requestPreferences();
        $('motion').setAttribute('aria-pressed', 'true');
      }
      canvas.focus({ preventScroll: true });
      window.scrollTo(0, 0);
    };
  } catch (error) {
    ready = false;
    playArea.hidden = true;
    $('loading').hidden = true;
    $('load-error').textContent = `${String(error)} No saved run was replaced. Reload the page to try again.`;
    $('load-error').hidden = false;
    $('start').textContent = 'Reload page';
    $('start').disabled = false;
    $('start').onclick = () => location.reload();
  } finally { clearTimeout(timer); }
}
$('start').onclick = loadGame;
