/* CubeHub Controller Extension for Gandi IDE / Scratch-compatible editors. */
(function (Scratch) {
    'use strict';

    if (!Scratch.extensions.unsandboxed) {
        throw new Error('CubeHub Controller requires an unsandboxed extension because it uses the browser Gamepad API.');
    }

    class ControllerExtension {
        constructor() {
            this.gamepads = new Map();
            this.previousButtons = new Map();
            this.currentButtons = new Map();
            this.lastFrame = new Map();
            this.polling = false;

            window.addEventListener('gamepadconnected', e => this.updateGamepad(e.gamepad));
            window.addEventListener('gamepaddisconnected', e => this.removeGamepad(e.gamepad));
            this.startPolling();
        }

        // Gamepad objects returned by getGamepads() are refreshed by the browser.
        // Always copy button state once per animation frame, then leave it alone
        // until the next frame. This makes edge detection deterministic.
        startPolling() {
            if (this.polling) return;
            this.polling = true;
            const loop = () => {
                this.poll();
                requestAnimationFrame(loop);
            };
            requestAnimationFrame(loop);
        }

        poll() {
            const pads = navigator.getGamepads ? navigator.getGamepads() : [];
            const active = new Set();

            for (const pad of pads) {
                if (!pad || !pad.connected) continue;
                active.add(pad.index);
                this.updateGamepad(pad);
            }

            for (const index of this.gamepads.keys()) {
                if (!active.has(index)) this.removeGamepadByIndex(index);
            }
        }

        readButton(button) {
            if (!button) return false;
            // GamepadButton is the normal modern representation. The numeric
            // fallback supports older implementations that exposed raw values.
            if (typeof button === 'object') {
                return !!button.pressed || Number(button.value) >= 0.5;
            }
            return Number(button) >= 0.5;
        }

        updateGamepad(pad) {
            const old = this.currentButtons.get(pad.index) || [];
            const current = Array.from(pad.buttons || [], b => this.readButton(b));

            // IMPORTANT: previous = state from the immediately preceding frame.
            // The old implementation could overwrite this relationship when a
            // reporter called refresh(), making "just pressed?" unreliable.
            this.previousButtons.set(pad.index, old.slice());
            this.currentButtons.set(pad.index, current);
            this.gamepads.set(pad.index, pad);
            this.lastFrame.set(pad.index, performance.now());
        }

        removeGamepad(pad) {
            if (pad) this.removeGamepadByIndex(pad.index);
        }

        removeGamepadByIndex(index) {
            this.gamepads.delete(index);
            this.currentButtons.delete(index);
            this.previousButtons.delete(index);
            this.lastFrame.delete(index);
        }

        getPad(which) {
            const requested = Math.max(1, Math.floor(Number(which) || 1));
            const pads = Array.from(this.gamepads.values()).sort((a, b) => a.index - b.index);
            return pads[requested - 1] || null;
        }

        buttonIndex(name) {
            const aliases = {
                a: 0, cross: 0,
                b: 1, circle: 1,
                x: 2, square: 2,
                y: 3, triangle: 3,
                lb: 4, l1: 4,
                rb: 5, r1: 5,
                lt: 6, l2: 6,
                rt: 7, r2: 7,
                back: 8, select: 8, share: 8, view: 8,
                start: 9, options: 9, menu: 9,
                l3: 10, leftstick: 10,
                r3: 11, rightstick: 11,
                dpadup: 12, up: 12,
                dpaddown: 13, down: 13,
                dpadleft: 14, left: 14,
                dpadright: 15, right: 15,
                home: 16, guide: 16, ps: 16,
                touchpad: 17, touchpadbutton: 17
            };
            const key = String(name || '').toLowerCase().replace(/[ _-]/g, '');
            if (Object.prototype.hasOwnProperty.call(aliases, key)) return aliases[key];
            const n = Number(name);
            return Number.isInteger(n) ? n : -1;
        }

        normalizeButton(name) {
            const map = {
                a: 'A', b: 'B', x: 'X', y: 'Y',
                cross: 'Cross', circle: 'Circle', square: 'Square', triangle: 'Triangle',
                lb: 'LB', rb: 'RB', lt: 'LT', rt: 'RT',
                l1: 'L1', r1: 'R1', l2: 'L2', r2: 'R2',
                back: 'Back / Share', start: 'Start / Options',
                l3: 'L3', r3: 'R3',
                dpadup: 'DPad Up', dpaddown: 'DPad Down',
                dpadleft: 'DPad Left', dpadright: 'DPad Right',
                home: 'Guide / PS', touchpad: 'Touchpad'
            };
            const key = String(name || '').toLowerCase().replace(/[ _-]/g, '');
            return map[key] || String(name);
        }

        getCurrentState(pad, index) {
            if (!pad || index < 0) return false;
            const buttons = this.currentButtons.get(pad.index) || [];
            return !!buttons[index];
        }

        getInfo() {
            return {
                id: 'cubehubcontroller',
                name: 'Controller',
                color1: '#5865F2', color2: '#4752C4', color3: '#3C45A5',
                blocks: [
                    { opcode: 'controllerCount', blockType: Scratch.BlockType.REPORTER, text: 'controllers connected' },
                    { opcode: 'controllerName', blockType: Scratch.BlockType.REPORTER, text: 'controller [CONTROLLER] name', arguments: { CONTROLLER: { type: Scratch.ArgumentType.NUMBER, defaultValue: 1 } } },
                    { opcode: 'controllerType', blockType: Scratch.BlockType.REPORTER, text: 'controller [CONTROLLER] type', arguments: { CONTROLLER: { type: Scratch.ArgumentType.NUMBER, defaultValue: 1 } } },
                    '---',
                    { opcode: 'buttonPressed', blockType: Scratch.BlockType.BOOLEAN, text: 'controller [CONTROLLER] [BUTTON] pressed?', arguments: { CONTROLLER: { type: Scratch.ArgumentType.NUMBER, defaultValue: 1 }, BUTTON: { type: Scratch.ArgumentType.STRING, menu: 'buttons', defaultValue: 'A' } } },
                    { opcode: 'buttonJustPressed', blockType: Scratch.BlockType.BOOLEAN, text: 'controller [CONTROLLER] [BUTTON] just pressed?', arguments: { CONTROLLER: { type: Scratch.ArgumentType.NUMBER, defaultValue: 1 }, BUTTON: { type: Scratch.ArgumentType.STRING, menu: 'buttons', defaultValue: 'A' } } },
                    { opcode: 'buttonValue', blockType: Scratch.BlockType.REPORTER, text: 'controller [CONTROLLER] [BUTTON] value', arguments: { CONTROLLER: { type: Scratch.ArgumentType.NUMBER, defaultValue: 1 }, BUTTON: { type: Scratch.ArgumentType.STRING, menu: 'buttons', defaultValue: 'A' } } },
                    { opcode: 'axisValue', blockType: Scratch.BlockType.REPORTER, text: 'controller [CONTROLLER] axis [AXIS]', arguments: { CONTROLLER: { type: Scratch.ArgumentType.NUMBER, defaultValue: 1 }, AXIS: { type: Scratch.ArgumentType.NUMBER, defaultValue: 1 } } },
                    { opcode: 'stickValue', blockType: Scratch.BlockType.REPORTER, text: 'controller [CONTROLLER] [STICK] [DIRECTION]', arguments: { CONTROLLER: { type: Scratch.ArgumentType.NUMBER, defaultValue: 1 }, STICK: { type: Scratch.ArgumentType.STRING, menu: 'sticks', defaultValue: 'Left stick' }, DIRECTION: { type: Scratch.ArgumentType.STRING, menu: 'directions', defaultValue: 'X' } } },
                    { opcode: 'anyButtonPressed', blockType: Scratch.BlockType.BOOLEAN, text: 'controller [CONTROLLER] any button pressed?', arguments: { CONTROLLER: { type: Scratch.ArgumentType.NUMBER, defaultValue: 1 } } },
                    '---',
                    { opcode: 'rumble', blockType: Scratch.BlockType.COMMAND, text: 'rumble controller [CONTROLLER] for [DURATION] secs strength [STRENGTH]', arguments: { CONTROLLER: { type: Scratch.ArgumentType.NUMBER, defaultValue: 1 }, DURATION: { type: Scratch.ArgumentType.NUMBER, defaultValue: 0.2 }, STRENGTH: { type: Scratch.ArgumentType.NUMBER, defaultValue: 1 } } }
                ],
                menus: {
                    buttons: { acceptReporters: true, items: ['A','B','X','Y','Cross','Circle','Square','Triangle','LB','RB','LT','RT','L1','R1','L2','R2','Back / Share','Start / Options','L3','R3','DPad Up','DPad Down','DPad Left','DPad Right','Guide / PS','Touchpad'] },
                    sticks: ['Left stick', 'Right stick'],
                    directions: ['X', 'Y']
                }
            };
        }

        controllerCount() { return this.gamepads.size; }
        controllerName(args) { const p = this.getPad(args.CONTROLLER); return p ? p.id : ''; }

        controllerType(args) {
            const p = this.getPad(args.CONTROLLER);
            if (!p) return 'None';
            const id = p.id.toLowerCase();
            if (id.includes('dualsense') || id.includes('054c')) return 'PlayStation';
            if (id.includes('xbox') || id.includes('xinput') || id.includes('045e')) return 'Xbox';
            return p.mapping === 'standard' ? 'Standard gamepad' : 'Gamepad';
        }

        buttonPressed(args) {
            const p = this.getPad(args.CONTROLLER);
            return this.getCurrentState(p, this.buttonIndex(args.BUTTON));
        }

        buttonJustPressed(args) {
            const p = this.getPad(args.CONTROLLER);
            if (!p) return false;
            const i = this.buttonIndex(args.BUTTON);
            if (i < 0) return false;
            const current = this.getCurrentState(p, i);
            const previous = !!((this.previousButtons.get(p.index) || [])[i]);
            return current && !previous;
        }

        buttonValue(args) {
            const p = this.getPad(args.CONTROLLER);
            const i = this.buttonIndex(args.BUTTON);
            return p && i >= 0 && p.buttons[i] ? Number(p.buttons[i].value || 0) : 0;
        }

        axisValue(args) {
            const p = this.getPad(args.CONTROLLER);
            const i = Math.max(0, Math.floor(Number(args.AXIS) || 1) - 1);
            return p && Number.isFinite(p.axes[i]) ? p.axes[i] : 0;
        }

        stickValue(args) {
            const p = this.getPad(args.CONTROLLER);
            const stick = String(args.STICK).toLowerCase().startsWith('right') ? 2 : 0;
            const axis = stick + (String(args.DIRECTION).toUpperCase() === 'Y' ? 1 : 0);
            return p && Number.isFinite(p.axes[axis]) ? p.axes[axis] : 0;
        }

        anyButtonPressed(args) {
            const p = this.getPad(args.CONTROLLER);
            return !!(p && (this.currentButtons.get(p.index) || []).some(Boolean));
        }

        async rumble(args) {
            const p = this.getPad(args.CONTROLLER);
            const actuator = p && (p.vibrationActuator || (p.hapticActuators && p.hapticActuators[0]));
            if (!actuator || typeof actuator.playEffect !== 'function') return;
            const duration = Math.max(0, Math.min(10000, Number(args.DURATION) * 1000 || 0));
            const strength = Math.max(0, Math.min(1, Number(args.STRENGTH)));
            try {
                await actuator.playEffect('dual-rumble', { startDelay: 0, duration, weakMagnitude: strength, strongMagnitude: strength });
            } catch (_) {}
        }
    }

    Scratch.extensions.register(new ControllerExtension());
})(Scratch);
