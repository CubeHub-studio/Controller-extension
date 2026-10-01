# 🎮 CubeHub Controller Extension

A Gandi IDE / Scratch-compatible extension that reads physical game controllers through the browser's **Gamepad API**.

## Supported controllers

- 🎮 PlayStation DualSense / compatible PlayStation controllers
- 🟩 Xbox controllers
- Other controllers that expose the browser's standard Gamepad API

No server, native program, or API key is required.

## Load in Gandi IDE

Use the raw GitHub Pages URL after enabling GitHub Pages for this repository:

`https://cubehub-studio.github.io/Controller-extension/extension.js`

Or, if Gandi accepts GitHub raw extension URLs directly:

`https://raw.githubusercontent.com/CubeHub-studio/Controller-extension/main/extension.js`

The extension is designed to run **unsandboxed**, because browser gamepads are exposed through `navigator.getGamepads()` and related browser events.

## Blocks

### Controller information

- `controllers connected`
- `controller (1) name`
- `controller (1) type`

### Buttons

- `controller (1) (A) pressed?`
- `controller (1) (A) value`
- `controller (1) any button pressed?`
- `controller (1) (A) just pressed?`

Supported named buttons include A/B/X/Y, Cross/Circle/Square/Triangle, LB/RB/LT/RT, L1/R1/L2/R2, Back, Start, L3, R3, D-pad directions, Home/Guide, and Touchpad.

### Sticks / axes

- `controller (1) axis (1)`
- `controller (1) (Left stick) (X)`
- `controller (1) (Right stick) (Y)`

Stick values normally range from approximately `-1` to `1`.

### Optional rumble

- `rumble controller (1) for (0.2) secs strength (1)`

Rumble depends on browser and controller support. The rest of the extension continues working if rumble is unavailable.

## Browser behavior

Connect the controller before or after loading the extension. The extension listens for `gamepadconnected` / `gamepaddisconnected` and continuously polls `navigator.getGamepads()`.

Some browsers only expose a controller after the user interacts with the page or presses a controller button. This is normal Gamepad API behavior.

## Standard mapping

The extension uses the browser's standard gamepad mapping where available. This gives common A/B/X/Y-style indices for Xbox controllers and corresponding Cross/Circle/Square/Triangle controls on PlayStation controllers, while also exposing named aliases for both layouts.
