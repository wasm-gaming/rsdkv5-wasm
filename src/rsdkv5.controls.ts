/**
 * Remapping the controls, in front of RSDKv5.
 *
 * The engine binds its keys in the generated `Settings.ini` (`[Keyboard Map 1]`, read once at
 * boot) and its pad through SDL's game-controller layer; both reach it through Emscripten's
 * SDL2 on the page. So a player's bindings are applied live, before SDL sees anything:
 *
 * - **Keys**: a physical key bound to a control is swallowed and replayed as the key the engine
 *   binds that control to by default; a default key no control has any more is swallowed.
 * - **Pads**: `navigator.getGamepads()` is wrapped while the game runs, and each pad's buttons
 *   are reordered so that the button a player chose sits where the engine's default looks for it.
 *
 * The controls are the d-pad, A B X Y, Start and Select.
 */



/** A control a player can rebind: its default key (`KeyboardEvent.code` / `.key`) and pad button. */
export interface Rsdkv5ControlSpec {
  id: string;
  label: string;
  code: string;
  key: string;
  /** Its button by default (standard mapping). */
  button: number;
}

/**
 * The engine's default bindings: the keyboard the SDK writes into `Settings.ini`
 * (`KEYBOARD_MAP_1`: arrows, A / S for A / B, Z / X for X / Y, Enter, Tab), and the pad SDL's
 * game-controller layer gives it (A B X Y, Back, Start). C and Z, keyboard-only aliases
 * with no pad button, are left as the engine has them.
 */
export const RSDKV5_CONTROLS: readonly Rsdkv5ControlSpec[] = Object.freeze([
  { id: 'a', label: 'A', code: 'KeyA', key: 'a', button: 0 },
  { id: 'b', label: 'B', code: 'KeyS', key: 's', button: 1 },
  { id: 'x', label: 'X', code: 'KeyZ', key: 'z', button: 2 },
  { id: 'y', label: 'Y', code: 'KeyX', key: 'x', button: 3 },
  { id: 'start', label: 'Start', code: 'Enter', key: 'Enter', button: 9 },
  { id: 'select', label: 'Select', code: 'Tab', key: 'Tab', button: 8 },
  { id: 'up', label: 'Up', code: 'ArrowUp', key: 'ArrowUp', button: 12 },
  { id: 'down', label: 'Down', code: 'ArrowDown', key: 'ArrowDown', button: 13 },
  { id: 'left', label: 'Left', code: 'ArrowLeft', key: 'ArrowLeft', button: 14 },
  { id: 'right', label: 'Right', code: 'ArrowRight', key: 'ArrowRight', button: 15 },
]);

/** The player's bindings, by control id: physical keys and pad buttons. */
export interface Rsdkv5Controls {
  keys?: Record<string, string>;
  buttons?: Record<string, number>;
}

export interface Rsdkv5ControlTables {
  /** Physical key → the control's default key, for the keys that moved. */
  keys: Map<string, Rsdkv5ControlSpec>;
  /** Default keys no control has any more. */
  blocked: Set<string>;
  /** Default button → the button the player chose for that control, where they differ. */
  pad: Map<number, number>;
}

export function controlTables(controls: Rsdkv5Controls = {}): Rsdkv5ControlTables {
  const keys = new Map<string, Rsdkv5ControlSpec>();
  const bound = new Set<string>();
  const pad = new Map<number, number>();
  for (const control of RSDKV5_CONTROLS) {
    const physical = controls.keys?.[control.id] ?? control.code;
    bound.add(physical);
    if (physical !== control.code) keys.set(physical, control);
    const button = controls.buttons?.[control.id] ?? control.button;
    if (button !== control.button) pad.set(control.button, button);
  }
  const blocked = new Set(RSDKV5_CONTROLS.map((control) => control.code).filter((code) => !bound.has(code)));
  return { keys, blocked, pad };
}

type PadLike = {
  readonly id: string;
  readonly index: number;
  readonly connected: boolean;
  readonly mapping: string;
  readonly timestamp: number;
  readonly axes: readonly number[];
  readonly buttons: ReadonlyArray<{ pressed: boolean; touched?: boolean; value: number }>;
};

/** A pad with its buttons reordered by `pad` (default button → chosen button). */
export function remapPad<T extends PadLike>(source: T, table: ReadonlyMap<number, number>): PadLike {
  if (table.size === 0) return source;
  const buttons = [...source.buttons];
  for (const [target, from] of table) {
    const button = source.buttons[from];
    buttons[target] = button ? { pressed: button.pressed, touched: button.touched ?? button.pressed, value: button.value } : { pressed: false, touched: false, value: 0 };
  }
  // A button taken for a control does only that: where it was not itself a control's
  // default slot, what the engine would read there by default is released.
  const targets = new Set(table.keys());
  for (const from of table.values()) {
    if (!targets.has(from)) buttons[from] = { pressed: false, touched: false, value: 0 };
  }
  return {
    id: source.id,
    index: source.index,
    connected: source.connected,
    mapping: source.mapping,
    timestamp: source.timestamp,
    axes: source.axes,
    buttons,
  };
}

/** `KeyboardEvent.keyCode` of the default keys, which SDL's Emscripten port also reads. */
const KEY_CODES: Readonly<Record<string, number>> = {
  Tab: 9,
  Enter: 13,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
};
export const keyCodeOf = (control: Rsdkv5ControlSpec): number =>
  KEY_CODES[control.code] ?? control.key.toUpperCase().charCodeAt(0);
