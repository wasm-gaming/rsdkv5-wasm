// rsdkv5's own app: what a host gets when it mounts this engine instead of driving
// the SDK itself — the game with Mania's own menus and a pause menu, on the wasm-gaming
// usability scheme (engine-specs UX.md); optionally a load-game screen of its own.
//
//   import * as app from '<engines>/rsdkv5/app/app.js'
//   const handle = await app.mount(target, host)   // EngineApp.mount
//   await handle.unmount()
//
// `host` is engine-specs' EngineAppHost: { game, storage, assets, input, exit }. The
// input is the host's createInput(): resumed it delivers menu actions; suspended (in
// game) only Select+Start and Escape come through, as `menu`.
//
// By default the app boots straight into the game, with Mania's own title and menus —
// its save select is where slots are chosen (and deleted, and Encore, Time Attack…).
// With `host.options.loadGame = 'app'` it shows its own slot screen first instead:
// the slots come from the SDK's `saves` (SaveData.bin read directly; a slot started
// through the build's bridge, which replays Mania's own save-select action, so Mania
// writes its file itself). Mania only loads its save once a scene with SaveGame is
// up, so the game keeps running — muted — behind the slot screen until it has, then
// pauses. A wasm without the bridge gets the phase-A app: the game with its own menus.
//
// Plain JS and DOM on purpose: the app ships inside the engine's package next to the
// SDK and loads from a static server, so it imports nothing but the SDK.

import Rsdkv5SDK, { MANIA_CHARACTERS, RSDKV5_CONTROLS } from '../rsdkv5.sdk.js';
import {
  SHARED_SETTINGS,
  controlsModel,
  createFullscreenToggle,
  createPerfCounter,
  createSettingsScreen,
  createWakeLock,
  loadSettings,
  resolveLocale,
  saveSettings,
  settingsDefaults,
  settingsModel,
} from '../engine-specs.js';

const ENGINE = 'rsdkv5';
const OWNER = 'app';
const ENGINE_ID = 'rsdkv5';

/** The app's words, in English and Spanish (engine-specs UX.md, "Languages"). */
const STRINGS = {
  booting: { en: 'Starting the engine…', es: 'Arrancando el motor…' },
  bootFailed: { en: 'Could not start', es: 'No se pudo arrancar' },
  back: { en: 'Back', es: 'Volver' },
  chooseGame: { en: 'Choose a game', es: 'Elige partida' },
  game: { en: 'game', es: 'partida' },
  character: { en: 'character', es: 'personaje' },
  continueHint: { en: 'continue', es: 'continuar' },
  playHint: { en: 'play', es: 'jugar' },
  deleteHint: { en: 'delete', es: 'borrar' },
  backHint: { en: 'back', es: 'volver' },
  quitHint: { en: 'quit', es: 'salir' },
  choose: { en: 'choose', es: 'elegir' },
  paused: { en: 'Paused', es: 'Pausa' },
  continue: { en: 'Continue', es: 'Continuar' },
  changeGame: { en: 'Change game', es: 'Cambiar de partida' },
  changeGameHint: { en: 'back to the saved games', es: 'vuelve a las partidas guardadas' },
  packScreenHint: { en: "the game's own screen", es: 'pantalla del propio juego' },
  settings: { en: 'Settings', es: 'Ajustes' },
  fullscreen: { en: 'Fullscreen', es: 'Pantalla completa' },
  fullscreenHint: { en: 'Alt+Enter · Select + Y', es: 'Alt+Enter · Select + Y' },
  fullscreenHintMac: { en: 'Cmd+Enter · Select + Y', es: 'Cmd+Enter · Select + Y' },
  exit: { en: 'Back to the launcher', es: 'Volver al lanzador' },
  leaveAsk: { en: 'Back to the launcher?', es: '¿Volver al lanzador?' },
  leaveText: { en: 'The game saves where the game itself saves.', es: 'La partida se guarda donde la guarde el juego.' },
  leave: { en: 'Leave', es: 'Salir' },
  stay: { en: 'Stay', es: 'Seguir' },
  deleteAsk: { en: 'Delete game {n}?', es: '¿Borrar la partida {n}?' },
  noUndo: { en: 'This cannot be undone.', es: 'No se puede deshacer.' },
  delete: { en: 'Delete', es: 'Borrar' },
  cancel: { en: 'Cancel', es: 'Cancelar' },
  levelSelect: { en: 'Level select', es: 'Selector de nivel' },
  titleScreen: { en: 'Title screen', es: 'Pantalla de título' },
  gameMenu: { en: "The game's menu", es: 'Menú del juego' },
  loadingGames: { en: 'Loading games…', es: 'Cargando partidas…' },
  maniaMenus: { en: "Mania's menus", es: 'menús de Mania' },
  savesFailed: { en: 'Mania could not load its saves.', es: 'Mania no ha podido cargar sus partidas.' },
  stageMenu: { en: 'Stage menu', es: 'Menú de fases' },
  sonicAndTails: { en: 'Sonic and Tails', es: 'Sonic y Tails' },
};

const DIRECTIONS = {
  up: { en: 'Up', es: 'Arriba' },
  down: { en: 'Down', es: 'Abajo' },
  left: { en: 'Left', es: 'Izquierda' },
  right: { en: 'Right', es: 'Derecha' },
};
/** The pad's buttons, for Ajustes → Controles. */
const BUTTONS = RSDKV5_CONTROLS.map((c) => ({ id: c.id, label: DIRECTIONS[c.id] ?? c.label }));
const DEFAULT_CONTROLS = Object.fromEntries(RSDKV5_CONTROLS.map((c) => [c.id, { code: c.code, button: c.button }]));
/** Bindings (engine-specs) → what `play.setControls()` takes. */
const toControls = (bindings) => ({
  keys: Object.fromEntries(Object.entries(bindings).filter(([, b]) => b.code).map(([id, b]) => [id, b.code])),
  buttons: Object.fromEntries(Object.entries(bindings).filter(([, b]) => Number.isInteger(b.button)).map(([id, b]) => [id, b.button])),
});

/**
 * The game's own screens worth jumping to from the pause menu, looked up by scene
 * name in the live stage list. Only the ones the loaded Data.rsdk has are offered.
 */
export const GAME_SCREENS = [
  { match: /^TITLE( SCREEN)?$/i, key: 'titleScreen' },
  { match: /^(MAIN MENU|MENU|SAVE SELECT|STAGE MENU)$/i, key: 'gameMenu' },
  { match: /^(LEVEL|STAGE) SELECT$/i, key: 'levelSelect' }, // Sonic CD: STAGE SELECT
];

/** `[{ label, list, scene }]` for the GAME_SCREENS found in a devMenu stage list. */
export const findGameScreens = (lists) => {
  const found = [];
  for (const screen of GAME_SCREENS) {
    for (let list = 0; list < (lists?.length ?? 0); list++) {
      const scene = (lists[list]?.stages ?? []).findIndex(({ name } = {}) => screen.match.test(String(name ?? '').trim()));
      if (scene >= 0) {
        found.push({ key: screen.key, list, scene });
        break;
      }
    }
  }
  return found;
};

const asset = (path) => new URL(`./assets/${path}`, import.meta.url).href;

/** Art per Mania character (`characterID`); Mighty and Ray have none here: a badge. */
const PLAYER_ART = ['sonictails', 'sonic', 'tails', 'knuckles', null, null];
const GEMS = ['#58e058', '#f0a038', '#f078d8', '#9878f0', '#f0f0f0', '#f07878', '#78c0f8'];
const ZONE_COUNT = 12; // Green Hill … Titanic Monarch (Egg Reverie is the 13th, after them)
/** Mania's own zone abbreviations, by `zoneID`. */
const ZONE_CODES = ['GHZ', 'CPZ', 'SPZ', 'FBZ', 'PGZ', 'SSZ', 'HCZ', 'MSZ', 'OOZ', 'LRZ', 'MMZ', 'TMZ', 'ERZ'];

const playerArt = (character, cls = '') => {
  const art = PLAYER_ART[character];
  if (art) return `<img class="${cls}" src="${asset(`player-${art}.svg`)}" alt="">`;
  const name = MANIA_CHARACTERS[character] ?? '?';
  return `<span class="player-badge ${cls}" data-char="${character}">${name.charAt(0)}</span>`;
};

const esc = (text) => String(text ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

let cssLoaded = null;
const loadCss = () =>
  (cssLoaded ??= new Promise((resolve) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = new URL('./app.css', import.meta.url).href;
    link.onload = link.onerror = () => resolve();
    document.head.append(link);
  }));

export async function mount(target, host) {
  await loadCss();

  const locale = host.locale ?? resolveLocale();
  const t = (key, params = {}) =>
    (STRINGS[key]?.[locale] ?? STRINGS[key]?.en ?? key).replace(/\{(\w+)\}/g, (m, name) => (name in params ? String(params[name]) : m));

  const root = document.createElement('div');
  root.className = 'rsdk-app';
  root.style.setProperty('--accent', host.game?.accent ?? '#1d4ed8');
  const stage = document.createElement('div');
  stage.className = 'rsdk-stage';
  const overlay = document.createElement('div');
  overlay.className = 'rsdk-overlay';
  root.append(stage, overlay);
  target.append(root);

  /**
   * screen: 'boot' | 'slots' | 'game' | 'pause' | 'confirm' | 'error'
   * The slot screen is the top level before playing; from the pause menu it is one
   * level down (Back returns to the pause menu).
   */
  const state = {
    screen: 'boot',
    status: t('booting'),
    error: null,
    slots: [],
    focus: 1, // 0 = Mania's own menus, 1-8 = slots
    pick: Array(9).fill(0), // character per empty card
    characters: 4,
    from: null,
    waiting: false, // a slot was picked before Mania had its save loaded
    playing: false,
    pause: { items: [], focus: 0 },
    confirm: null, // { title, text, yes, no, onYes, onNo, focus, under }
  };
  let saveReady = null; // Promise<boolean>, once asked
  /** The app's slot screen instead of Mania's own save select: only when the host asks. */
  const useSlotScreen = host.options?.loadGame === 'app';

  let play = null;
  let leaving = false;
  let destroyed = false;

  const canvasFocus = () => stage.querySelector('canvas')?.focus({ preventScroll: true });
  const title = () => host.game?.title ?? 'Sonic Mania';

  // ---- screens ------------------------------------------------------------------

  const hints = (pairs) =>
    `<footer class="rsdk-hints">${pairs.map(([k, t]) => `<span><kbd>${k}</kbd>${t}</span>`).join('')}</footer>`;

  const render = () => {
    if (destroyed) return;
    const s = state.screen;
    wake.setActive(s === 'game' && setting('keepScreenOn') !== false);
    if (s === 'settings') return;
    root.dataset.screen = state.screen;
    if (s === 'game') {
      overlay.innerHTML = '';
      return;
    }
    if (s === 'boot') {
      overlay.innerHTML = `<section class="rsdk-boot">
        ${host.game?.art ? `<img src="${esc(host.game.art)}" alt="">` : ''}
        <p>${esc(state.status)}</p>
      </section>`;
      return;
    }
    if (s === 'error') {
      overlay.innerHTML = `<section class="rsdk-panel">
        <p class="kicker">${esc(title())}</p>
        <h2>${esc(t('bootFailed'))}</h2>
        <p class="text">${esc(state.error)}</p>
        <button class="item is-focused" data-exit>${esc(t('back'))}</button>
      </section>`;
      return;
    }
    let html = '';
    const base = s === 'confirm' ? state.confirm.under : s;
    if (base === 'slots') {
      const card = state.focus;
      const slot = card > 0 ? state.slots[card - 1] : null;
      const saved = slot && slot.state !== 'empty';
      html += `<section class="rsdk-slots">
        <header><p class="kicker">${esc(title())}</p><h2>${esc(state.waiting ? t('loadingGames') : t('chooseGame'))}</h2></header>
        <div class="slot-cards">${[0, 1, 2, 3, 4, 5, 6, 7, 8].map(slotCard).join('')}</div>
        ${hints([
          ['←→', t('game')],
          ...(card > 0 && !saved ? [['↑↓', t('character')]] : []),
          ['A', card === 0 ? t('maniaMenus') : saved ? t('continueHint') : t('playHint')],
          ['B', state.from === 'pause' ? t('backHint') : t('quitHint')],
        ])}
      </section>`;
    } else if (base === 'pause') {
      html += `<section class="rsdk-panel">
        <p class="kicker">${esc(title())}</p>
        <h2>${esc(t('paused'))}</h2>
        ${state.pause.items.map((item, i) => `<button class="item${i === state.pause.focus && s !== 'confirm' ? ' is-focused' : ''}" data-item="${i}">${esc(item.label)}${item.hint ? `<small>${esc(item.hint)}</small>` : ''}</button>`).join('')}
        ${hints([['A', t('choose')], ['B', t('continueHint')]])}
      </section>`;
    }
    if (s === 'confirm') {
      const c = state.confirm;
      html += `<div class="rsdk-confirm"><section class="rsdk-panel">
        <h2>${esc(c.title)}</h2>
        ${c.text ? `<p class="text">${esc(c.text)}</p>` : ''}
        <div class="row">
          <button class="item${c.focus === 0 ? ' is-focused' : ''}" data-confirm="0">${esc(c.no)}</button>
          <button class="item is-danger${c.focus === 1 ? ' is-focused' : ''}" data-confirm="1">${esc(c.yes)}</button>
        </div>
      </section></div>`;
    }
    overlay.innerHTML = html;
    // Nine cards don't fit most screens: keep the focused one in view (by hand —
    // scrollIntoView would also scroll the host's page).
    const cards = overlay.querySelector('.slot-cards');
    const focused = cards?.querySelector('.slot-card.is-focused');
    if (cards && focused && cards.scrollWidth > cards.clientWidth) {
      cards.style.scrollBehavior = 'auto';
      cards.scrollLeft = scrollMemo;
      cards.style.scrollBehavior = '';
      cards.scrollLeft = focused.offsetLeft - (cards.clientWidth - focused.offsetWidth) / 2;
    }
    scrollMemo = cards?.scrollLeft ?? 0;
  };
  let scrollMemo = 0;

  // craft's slot cards (rsdkv4's app), on Mania's data: the first card goes to Mania's
  // own menus (Encore, Time Attack…); a saved slot shows where it stopped, an empty
  // one is the character picker over PLAY.
  function slotCard(i) {
    const focused = state.focus === i ? ' is-focused' : '';
    if (i === 0) {
      return `<div class="slot-card is-nosave${focused}" data-card="0" role="button">MANIA<br>MENUS</div>`;
    }
    const slot = state.slots[i - 1];
    if (!slot || slot.state === 'empty') {
      const character = state.pick[i];
      return `<div class="slot-card is-new${focused}" data-focus="${i}">
        <button type="button" class="player-choose" data-player="${PLAYER_ART[character] ?? 'badge'}" data-pick="${i}" data-dir="1"
                title="${esc(MANIA_CHARACTERS[character])}">${playerArt(character)}</button>
        <button type="button" class="slot-play" data-card="${i}">PLAY</button>
      </div>`;
    }
    const complete = slot.state === 'complete';
    const zoneTag = `${i} · ${complete ? 'CLEAR' : slot.zone < ZONE_COUNT ? `ZONE ${slot.zone + 1}` : 'FINAL'}`;
    const code = complete ? '★' : (ZONE_CODES[slot.zone] ?? '?');
    const name = complete ? 'GAME CLEAR' : slot.zoneName.toUpperCase();
    return `<div class="slot-card is-saved${focused}" data-focus="${i}">
      <div class="stage-shot">
        <div class="stage-badge is-mania"><span>${esc(code)}</span></div>
        <div class="zone-tag">${esc(zoneTag)}</div>
        <div class="player-icon">${playerArt(slot.character)}</div>
      </div>
      <div class="zone-title" title="${esc(name)} · ${esc(MANIA_CHARACTERS[slot.character])}">${esc(name)}</div>
      <div class="emeralds" title="${slot.emeralds} of 7 chaos emeralds">${GEMS.map((c, g) => `<i style="--gem:${c}"${g < slot.emeralds ? ' class="on"' : ''}></i>`).join('')}</div>
      <div class="stats-grid">
        <span title="Lives"><svg viewBox="0 0 16 16" aria-hidden="true"><path fill="#f43f5e" d="M8 14.2 1.9 8.4A3.6 3.6 0 0 1 8 3.6a3.6 3.6 0 0 1 6.1 4.8z"/></svg>${slot.lives}</span>
        <span title="Score"><svg viewBox="0 0 16 16" aria-hidden="true"><path fill="#fbbf24" d="m8 1.2 2.1 4.3 4.7.7-3.4 3.3.8 4.7L8 12l-4.2 2.2.8-4.7L1.2 6.2l4.7-.7z"/></svg>${slot.score}</span>
      </div>
      <button type="button" class="slot-play" data-card="${i}">CONTINUE</button>
    </div>`;
  }

  // ---- transitions --------------------------------------------------------------

  const refreshSlots = () => {
    try {
      state.slots = play?.saves.list() ?? [];
    } catch {
      state.slots = [];
    }
  };

  /**
   * Mania loads its save once a scene with SaveGame is up (the title screen): until
   * then the game runs muted behind the slot screen, then it is paused.
   */
  const askSaveReady = () =>
    (saveReady ??= play.saves.ready(30000).then((ready) => {
      if (state.screen === 'slots' || state.screen === 'confirm') play.pause(OWNER);
      return ready;
    }));

  const showSlots = (from = null) => {
    refreshSlots();
    state.from = from;
    state.screen = 'slots';
    host.input.resume();
    if (from === 'pause') play.pause(OWNER);
    render();
  };

  const startSlot = async (card) => {
    if (state.waiting) return;
    if (card === 0) return playManiaMenus();
    const slot = card - 1;
    state.waiting = true;
    render();
    const ready = await askSaveReady();
    state.waiting = false;
    if (destroyed || leaving) return;
    if (!ready) {
      state.error = t('savesFailed');
      render();
      return playManiaMenus();
    }
    state.screen = 'game';
    state.playing = true;
    render();
    host.input.suspend();
    play.mute(false);
    play.saves.start(slot, state.pick[card]); // also lifts the pause
    canvasFocus();
  };

  /** The game as it is, with Mania's own title and menus. */
  const playManiaMenus = () => {
    state.playing = true;
    play.mute(false);
    play.resume(OWNER);
    enterGame();
  };

  const cyclePlayer = (card, dir) => {
    const count = state.characters;
    state.pick[card] = (state.pick[card] + dir + count) % count;
    render();
  };

  const enterGame = () => {
    state.screen = 'game';
    render();
    host.input.suspend();
    canvasFocus();
  };

  const gameScreens = () => {
    try {
      return findGameScreens(play.devMenu.getStageList());
    } catch {
      return [];
    }
  };

  const openPause = () => {
    play?.pause(OWNER);
    state.pause = {
      focus: 0,
      items: [
        { label: t('continue'), run: closePause },
        ...(useSlotScreen && play?.saves.available
          ? [{ label: t('changeGame'), hint: t('changeGameHint'), run: () => showSlots('pause') }]
          : []),
        ...gameScreens().map((screen) => ({
          label: t(screen.key),
          hint: t('packScreenHint'),
          run: () => {
            closePause();
            play.devMenu.loadStage(screen.list, screen.scene);
          },
        })),
        { label: t('settings'), run: openSettings },
        {
          label: t('fullscreen'),
          hint: /mac|iphone|ipad/i.test(navigator.userAgentData?.platform || navigator.platform || '') ? t('fullscreenHintMac') : t('fullscreenHint'),
          run: () => fullscreen.toggle(),
        },
        { label: t('exit'), run: askExit },
      ],
    };
    state.screen = 'pause';
    host.input.resume();
    render();
  };

  const closePause = () => {
    enterGame();
    play?.resume(OWNER);
  };

  // A confirm sits on top of the screen it was asked from and goes back to it.
  const ask = (options) => {
    state.confirm = { focus: 0, under: state.screen, ...options };
    state.screen = 'confirm';
    render();
  };
  const answer = (yes) => {
    const c = state.confirm;
    state.screen = c.under;
    state.confirm = null;
    render();
    (yes ? c.onYes : c.onNo)?.();
  };

  const exit = async () => {
    if (leaving) return;
    leaving = true;
    try {
      await play?.destroy();
    } catch (error) {
      console.warn(`[${ENGINE} app] destroy failed`, error);
    }
    play = null;
    host.exit();
  };

  const askExit = () =>
    ask({ title: t('leaveAsk'), text: t('leaveText'), yes: t('leave'), no: t('stay'), onYes: exit });

  // ---- settings, fullscreen, performance (engine-specs 0.6) -----------------------

  // The player's choices, per engine (OPFS settings/<engine>.json): the engine's config
  // (smoothing), the shared ones (keep the screen on, show performance) and the controls.
  let saved = { version: 1, values: {}, controls: {} };
  const setting = (key) => (key in saved.values ? saved.values[key] : SHARED_SETTINGS[key]?.default);
  const store = () => saveSettings(ENGINE_ID, saved).catch((error) => console.warn(`[${ENGINE_ID} app] settings not saved`, error));
  const engineValues = () =>
    Object.fromEntries(Object.entries(saved.values).filter(([key]) => !(key in SHARED_SETTINGS)));

  const fullscreen = createFullscreenToggle(root);
  const wake = createWakeLock();
  // The engine runs its own loop and reports no frames: the counter counts the display's.
  const perf = createPerfCounter(root, { locale });
  const applyShared = () => {
    if (setting('showPerformance')) perf.show();
    else perf.hide();
    wake.setActive(state.screen === 'game' && setting('keepScreenOn') !== false);
  };

  let screen = null;
  // Only the config's labelled rows are settings: the pack's GAME OPTIONS stay in the game.
  const described = async () => ({ ...(await play.config()), ...SHARED_SETTINGS });
  const controlRows = () => controlsModel(BUTTONS, DEFAULT_CONTROLS, saved.controls, locale);

  const openSettings = async () => {
    const all = await described();
    state.screen = 'settings';
    render();
    overlay.innerHTML = '';
    const layer = document.createElement('div');
    layer.className = 'rsdk-confirm rsdk-settings';
    overlay.append(layer);
    screen = createSettingsScreen(layer, {
      sections: settingsModel(all, saved.values, locale),
      controls: controlRows(),
      input: host.input,
      locale,
      onChange(key, value) {
        saved.values = { ...saved.values, [key]: value };
        if (key in SHARED_SETTINGS) applyShared();
        else play.config({ [key]: value });
        void store();
      },
      onControl(_id, _binding, bindings) {
        saved.controls = bindings;
        play.setControls(toControls(bindings));
        void store();
      },
      onReset() {
        const defaults = settingsDefaults(all);
        saved = { version: 1, values: {}, controls: {} };
        play.config(Object.fromEntries(Object.entries(defaults).filter(([key]) => !(key in SHARED_SETTINGS))));
        play.setControls({});
        applyShared();
        void store();
        screen.update(settingsModel(all, defaults, locale), controlRows());
      },
      onClose: () => {
        screen?.destroy();
        screen = null;
        openPause();
      },
    });
  };

  // ---- input ----------------------------------------------------------------------

  const onSlots = (action) => {
    const card = state.focus;
    const slot = card > 0 ? state.slots[card - 1] : null;
    const saved = slot && slot.state !== 'empty';
    if (state.waiting) return;
    if (action === 'left' || action === 'prev') state.focus = Math.max(0, card - 1);
    else if (action === 'right' || action === 'next') state.focus = Math.min(8, card + 1);
    else if ((action === 'up' || action === 'down') && card > 0 && !saved) return cyclePlayer(card, action === 'up' ? -1 : 1);
    else if (action === 'accept') return startSlot(card);
    else if (action === 'back' || action === 'menu') {
      if (state.from === 'pause') return openPause();
      return askExit();
    } else return;
    render();
  };

  const onPause = (action) => {
    const p = state.pause;
    if (action === 'up') p.focus = (p.focus + p.items.length - 1) % p.items.length;
    else if (action === 'down') p.focus = (p.focus + 1) % p.items.length;
    else if (action === 'accept') return p.items[p.focus].run();
    else if (action === 'back' || action === 'menu') return closePause();
    else return;
    render();
  };

  const onConfirm = (action) => {
    const c = state.confirm;
    if (action === 'left' || action === 'up') c.focus = 0;
    else if (action === 'right' || action === 'down') c.focus = 1;
    else if (action === 'accept') return answer(c.focus === 1);
    else if (action === 'back') return answer(false);
    else return;
    render();
  };

  const off = host.input.on((action) => {
    if (leaving) return;
    const s = state.screen;
    if (s === 'settings') return;
    if (s === 'game') {
      if (action === 'menu') openPause();
    } else if (s === 'slots') onSlots(action);
    else if (s === 'pause') onPause(action);
    else if (s === 'confirm') onConfirm(action);
    else if (s === 'error' && (action === 'accept' || action === 'back')) exit();
    else if (s === 'boot' && action === 'back') exit();
  });

  // Pointer: hover focuses, click activates — the same paths as the pad. Hover is read
  // from real movement only: every render replaces the buttons, and the browser fires
  // a fresh pointerover for whatever lands under a resting cursor.
  let lastPointer = '';
  const onPointer = (event) => {
    if (event.type === 'pointermove') {
      const at = `${event.clientX},${event.clientY}`;
      if (at === lastPointer) return;
      lastPointer = at;
    }
    const el = event.target.closest('[data-card],[data-item],[data-confirm],[data-exit],[data-pick],[data-focus]');
    if (!el || leaving) return;
    if (event.type === 'pointermove') {
      const card = el.closest('[data-focus]')?.dataset.focus ?? el.dataset.card ?? el.dataset.pick;
      if (card != null && state.screen === 'slots' && state.focus !== +card) {
        state.focus = +card;
        render();
      } else if (el.dataset.item != null && state.screen === 'pause' && state.pause.focus !== +el.dataset.item) {
        state.pause.focus = +el.dataset.item;
        render();
      }
      return;
    }
    if (el.dataset.pick != null) {
      event.stopPropagation();
      state.focus = +el.dataset.pick;
      return cyclePlayer(+el.dataset.pick, +el.dataset.dir);
    }
    if (el.dataset.card != null) {
      state.focus = +el.dataset.card;
      startSlot(+el.dataset.card);
    } else if (el.dataset.item != null) state.pause.items[+el.dataset.item].run();
    else if (el.dataset.confirm != null) answer(el.dataset.confirm === '1');
    else if (el.dataset.exit != null) exit();
  };
  overlay.addEventListener('click', onPointer);
  overlay.addEventListener('pointermove', onPointer);

  const handle = {
    async unmount() {
      destroyed = true;
      leaving = true;
      off();
      overlay.removeEventListener('click', onPointer);
      overlay.removeEventListener('pointermove', onPointer);
      try {
        await play?.destroy();
      } catch {
        /* already gone */
      }
      play = null;
      screen?.destroy();
      fullscreen.destroy();
      wake.destroy();
      perf.destroy();
      root.remove();
    },
  };

  // ---- boot -----------------------------------------------------------------------

  render();
  host.input.resume();
  try {
    saved = await loadSettings(ENGINE_ID);
    play = await new Rsdkv5SDK()
      .mount(stage)
      .assets(host.assets)
      .storage(host.storage)
      // The saved smoothing: the engine's config.
      .config(engineValues())
      .on('error', ({ detail }) => console.error(`[${ENGINE} app]`, detail))
      .on('saves', () => {
        if (state.screen === 'slots') {
          refreshSlots();
          render();
        }
      })
      .on('exit', () => exit())
      .start();
    if (destroyed) {
      // Unmounted while booting: nothing to show any more.
      await play.destroy().catch(() => {});
      play = null;
      return handle;
    }
    play.setControls(toControls({ ...DEFAULT_CONTROLS, ...saved.controls }));
    applyShared();
    // Mania's own menus by default: its save select does more than this app's (delete,
    // Encore, Time Attack…). A host can still ask for the app's slot screen.
    if (!useSlotScreen || !play.saves.available) {
      enterGame();
      return handle;
    }
    state.characters = play.saves.characters;
    play.mute(true);
    void askSaveReady();
    refreshSlots();
    // The first slot with a game in it is where most people want to be.
    const firstSaved = state.slots.findIndex((slot) => slot.state !== 'empty');
    state.focus = firstSaved >= 0 ? firstSaved + 1 : Math.max(1, state.slots.findIndex((slot) => slot.state === 'empty') + 1);
    showSlots();
  } catch (error) {
    console.error(`[${ENGINE} app]`, error);
    state.error = error?.message ?? String(error);
    state.screen = 'error';
    render();
  }

  return handle;
}
