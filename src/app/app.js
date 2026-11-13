// rsdkv5's own app: what a host gets when it mounts this engine instead of driving
// the SDK itself — a boot screen, then the game with its OWN title and save select,
// and a pause menu on the wasm-gaming usability scheme (engine-specs UX.md).
//
//   import * as app from '<engines>/rsdkv5/app/app.js'
//   const handle = await app.mount(target, host)   // EngineApp.mount
//   await handle.unmount()
//
// `host` is engine-specs' EngineAppHost: { game, storage, assets, input, exit }. The
// input is the host's createInput(): resumed it delivers menu actions; suspended (in
// game) only Select+Start and Escape come through, as `menu`.
//
// Unlike rsdkv4's app there is no load-game screen: Sonic Mania's menus are game
// code, with no native bridge to start a save (see RECORD/). Nor does this build
// expose the stage list yet, so the pause menu offers no game screens until it does.
//
// Plain JS and DOM on purpose: the app ships inside the engine's package next to the
// SDK and loads from a static server, so it imports nothing but the SDK.

import Rsdkv5SDK from '../rsdkv5.sdk.js';

const ENGINE = 'rsdkv5';
const OWNER = 'app';

/**
 * The game's own screens worth jumping to from the pause menu, looked up by scene
 * name in the live stage list. Only the ones the loaded Data.rsdk has are offered.
 */
export const GAME_SCREENS = [
  { match: /^TITLE( SCREEN)?$/i, label: 'Pantalla de título' },
  { match: /^(MAIN MENU|MENU|SAVE SELECT|STAGE MENU)$/i, label: 'Menú del juego' },
  { match: /^LEVEL SELECT$/i, label: 'Level select' },
];

/** `[{ label, list, scene }]` for the GAME_SCREENS found in a devMenu stage list. */
export const findGameScreens = (lists) => {
  const found = [];
  for (const screen of GAME_SCREENS) {
    for (let list = 0; list < (lists?.length ?? 0); list++) {
      const scene = (lists[list]?.stages ?? []).findIndex(({ name } = {}) => screen.match.test(String(name ?? '').trim()));
      if (scene >= 0) {
        found.push({ label: screen.label, list, scene });
        break;
      }
    }
  }
  return found;
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

  const root = document.createElement('div');
  root.className = 'rsdk-app';
  root.style.setProperty('--accent', host.game?.accent ?? '#1d4ed8');
  const stage = document.createElement('div');
  stage.className = 'rsdk-stage';
  const overlay = document.createElement('div');
  overlay.className = 'rsdk-overlay';
  root.append(stage, overlay);
  target.append(root);

  /** screen: 'boot' | 'game' | 'pause' | 'confirm' | 'error' */
  const state = {
    screen: 'boot',
    status: 'Arrancando el motor…',
    error: null,
    pause: { items: [], focus: 0 },
    confirm: null, // { title, text, yes, no, onYes, onNo, focus, under }
  };

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
    root.dataset.screen = state.screen;
    const s = state.screen;
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
        <h2>No se pudo arrancar</h2>
        <p class="text">${esc(state.error)}</p>
        <button class="item is-focused" data-exit>Volver</button>
      </section>`;
      return;
    }
    let html = '';
    const base = s === 'confirm' ? state.confirm.under : s;
    if (base === 'pause') {
      html += `<section class="rsdk-panel">
        <p class="kicker">${esc(title())}</p>
        <h2>Pausa</h2>
        ${state.pause.items.map((item, i) => `<button class="item${i === state.pause.focus && s !== 'confirm' ? ' is-focused' : ''}" data-item="${i}">${esc(item.label)}${item.hint ? `<small>${esc(item.hint)}</small>` : ''}</button>`).join('')}
        ${hints([['A', 'elegir'], ['B', 'continuar']])}
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
  };

  // ---- transitions --------------------------------------------------------------

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
        { label: 'Continuar', run: closePause },
        ...gameScreens().map((screen) => ({
          label: screen.label,
          hint: 'pantalla del propio juego',
          run: () => {
            closePause();
            play.devMenu.loadStage(screen.list, screen.scene);
          },
        })),
        { label: 'Volver al lanzador', run: askExit },
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
    ask({ title: '¿Volver al lanzador?', text: 'La partida se guarda donde la guarde el juego.', yes: 'Salir', no: 'Seguir', onYes: exit });

  // ---- input ----------------------------------------------------------------------

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
    if (s === 'game') {
      if (action === 'menu') openPause();
    } else if (s === 'pause') onPause(action);
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
    const el = event.target.closest('[data-item],[data-confirm],[data-exit]');
    if (!el || leaving) return;
    if (event.type === 'pointermove') {
      if (el.dataset.item != null && state.screen === 'pause' && state.pause.focus !== +el.dataset.item) {
        state.pause.focus = +el.dataset.item;
        render();
      }
      return;
    }
    if (el.dataset.item != null) state.pause.items[+el.dataset.item].run();
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
      root.remove();
    },
  };

  // ---- boot -----------------------------------------------------------------------

  render();
  host.input.resume();
  try {
    play = await new Rsdkv5SDK()
      .mount(stage)
      .assets(host.assets)
      .storage(host.storage)
      .on('error', ({ detail }) => console.error(`[${ENGINE} app]`, detail))
      .on('exit', () => exit())
      .start();
    if (destroyed) {
      // Unmounted while booting: nothing to show any more.
      await play.destroy().catch(() => {});
      play = null;
      return handle;
    }
    enterGame();
  } catch (error) {
    console.error(`[${ENGINE} app]`, error);
    state.error = error?.message ?? String(error);
    state.screen = 'error';
    render();
  }

  return handle;
}
