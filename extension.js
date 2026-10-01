/*
 * CubeHub Controller Extension for Gandi IDE / Scratch-compatible editors.
 * Uses the browser Gamepad API to read DualSense, Xbox, and other standard
 * gamepads without a native helper or server.
 */
(function (Scratch) {
    'use strict';

    if (!Scratch.extensions.unsandboxed) {
        throw new Error('CubeHub Controller requires an unsandboxed extension because it uses the browser Gamepad API.');
    }

    class ControllerExtension {
        constructor() {
            this.gamepads = [];
            this.previousButtons = new Map();
            this.currentButtons = new Map();
            this.axes = new Map();
            this.lastUpdate = 0;

            window.addEventListener('gamepadconnected', () => this.refresh());
            window.addEventListener('gamepaddisconnected', () => this.refresh());

            this.poll();
        }

        poll() {
            const pads = navigator.getGamepads ? Array.from(navigator.getGamepads()) : [];
            this.gamepads = pads.filter(Boolean);

            for (const pad of this.gamepads) {
                const oldButtons = this.currentButtons.get(pad.index) || [];
                const newButtons = pad.buttons.map(button => !!button.pressed);
                this.previousButtons.set(pad.index, oldButtons);
                this.currentButtons.set(pad.index, newButtons);
                this.axes.set(pad.index, pad.axes.slice());
            }

            const active = new Set(this.gamepads.map(pad => pad.index));
            for (const index of this.currentButtons.keys()) {
                if (!active.has(index)) {
                    this.currentButtons.delete(index);
                    this.previousButtons.delete(index);
                    this.axes.delete(index);
                }
            }

            this.lastUpdate = performance.now();
            requestAnimationFrame(() => this.poll());
        }

        refresh() {
            const pads = navigator.getGamepads ? Array.from(navigator.getGamepads()) : [];
            this.gamepads = pads.filter(Boolean);
        }

        getPad(which) {
            this.refresh();
            const index = Math.max(1, Math.floor(Number(which) || 1)) - 1;
            return this.gamepads[index] || null;
        }

        buttonIndex(name) {
            const aliases = {
                a: 0, cross: 0, x: 0,
                b: 1, circle: 1, o: 1,
                xbutton: 2, square: 2,
                y: 3, triangle: 3,
                lb: 4, l1: 4, rb: 5, r1: 5,
                lt: 6, l2: 6, rt: 7, r2: 7,
                back: 8, select: 8,
                start: 9,
                l3: 10, leftstick: 10,
                r3: 11, rightstick: 11,
                dpadup: 12, up: 12,
                dpaddown: 13, down: 13,
                dpadleft: 14, left: 14,
                dpadright: 15, right: 15,
                home: 16, guide: 16,
                touchpad: 17, touchpadbutton: 17
            };
            const key = String(name || '').toLowerCase().replace(/[ _-]/g, '');
            if (Object.prototype.hasOwnProperty.call(aliases, key)) return aliases[key];
            const n = Number(name);
            return Number.isInteger(n) ? n : -1;
        }

        normalizeButton(name) {
            const map = {
                a: 'A', b: 'B', xbutton: 'X', y: 'Y',
                cross: 'Cross', circle: 'Circle', square: 'Square', triangle: 'Triangle',
                lb: 'LB', rb: 'RB', lt: 'LT', rt: 'RT',
                l1: 'L1', r1: 'R1', l2: 'L2', r2: 'R2',
                back: 'Back', start: 'Start', l3: 'L3', r3: 'R3',
                dpadup: 'DPad Up', dpaddown: 'DPad Down',
                dpadleft: 'DPad Left', dpadright: 'DPad Right',
                home: 'Home', guide: 'Guide', touchpad: 'Touchpad'
            };
            const key = String(name || '').toLowerCase().replace(/[ _-]/g, '');
            return map[key] || String(name);
        }

        buttonPressed(pad, name) {
            const i = this.buttonIndex(name);
            return !!(pad && i >= 0 && pad.buttons[i] && pad.buttons[i].pressed);
        }

        buttonValue(pad, name) {
            const i = this.buttonIndex(name);
            return pad && i >= 0 && pad.buttons[i] ? pad.buttons[i].value : 0;
        }

        axisValue(pad, axis) {
            const n = Math.max(0, Math.floor(Number(axis) || 0));
            return pad && Number.isFinite(pad.axes[n]) ? pad.axes[n] : 0;
        }

        getInfo() {
            return {
                id: 'cubehubcontroller',
                name: 'Controller',
                color1: '#5865F2',
                color2: '#4752C4',
                color3: '#3C45A5',
                blocks: [
                    {
                        opcode: 'controllerCount',
                        blockType: Scratch.BlockType.REPORTER,
                        text: 'controllers connected',
                        disableMonitor: false
                    },
                    {
                        opcode: 'controllerName',
                        blockType: Scratch.BlockType.REPORTER,
                        text: 'controller [CONTROLLER] name',
                        arguments: { CONTROLLER: { type: Scratch.ArgumentType.NUMBER, defaultValue: 1 } }
                    },
                    {
                        opcode: 'controllerType',
                        blockType: Scratch.BlockType.REPORTER,
                        text: 'controller [CONTROLLER] type',
                        arguments: { CONTROLLER: { type: Scratch.ArgumentType.NUMBER, defaultValue: 1 } }
                    },
                    '---',
                    {
                        opcode: 'buttonPressed',
                        blockType: Scratch.BlockType.BOOLEAN,
                        text: 'controller [CONTROLLER] [BUTTON] pressed?',
                        arguments: {
                            CONTROLLER: { type: Scratch.ArgumentType.NUMBER, defaultValue: 1 },
                            BUTTON: { type: Scratch.ArgumentType.STRING, menu: 'buttons', defaultValue: 'A' }
                        }
                    },
                    {
                        opcode: 'buttonValue',
                        blockType: Scratch.BlockType.REPORTER,
                        text: 'controller [CONTROLLER] [BUTTON] value',
                        arguments: {
                            CONTROLLER: { type: Scratch.ArgumentType.NUMBER, defaultValue: 1 },
                            BUTTON: { type: Scratch.ArgumentType.STRING, menu: 'buttons', defaultValue: 'A' }
                        }
                    },
                    {
                        opcode: 'axisValue',
                        blockType: Scratch.BlockType.REPORTER,
                        text: 'controller [CONTROLLER] axis [AXIS]',
                        arguments: {
                            CONTROLLER: { type: Scratch.ArgumentType.NUMBER, defaultValue: 1 },
                            AXIS: { type: Scratch.ArgumentType.NUMBER, defaultValue: 1 }
                        }
                    },
                    {
                        opcode: 'stickValue',
                        blockType: Scratch.BlockType.REPORTER,
                        text: 'controller [CONTROLLER] [STICK] [DIRECTION]',
                        arguments: {
                            CONTROLLER: { type: Scratch.ArgumentType.NUMBER, defaultValue: 1 },
                            STICK: { type: Scratch.ArgumentType.STRING, menu: 'sticks', defaultValue: 'Left stick' },
                            DIRECTION: { type: Scratch.ArgumentType.STRING, menu: 'directions', defaultValue: 'X' }
                        }
                    },
                    {
                        opcode: 'anyButtonPressed',
                        blockType: Scratch.BlockType.BOOLEAN,
                        text: 'controller [CONTROLLER] any button pressed?',
                        arguments: { CONTROLLER: { type: Scratch.ArgumentType.NUMBER, defaultValue: 1 } }
                    },
                    {
                        opcode: 'buttonJustPressed',
                        blockType: Scratch.BlockType.BOOLEAN,
                        text: 'controller [CONTROLLER] [BUTTON] just pressed?',
                        arguments: {
                            CONTROLLER: { type: Scratch.ArgumentType.NUMBER, defaultValue: 1 },
                            BUTTON: { type: Scratch.ArgumentType.STRING, menu: 'buttons', defaultValue: 'A' }
                        }
                    },
                    '---',
                    {
                        opcode: 'rumble',
                        blockType: Scratch.BlockType.COMMAND,
                        text: 'rumble controller [CONTROLLER] for [DURATION] secs strength [STRENGTH]',
                        arguments: {
                            CONTROLLER: { type: Scratch.ArgumentType.NUMBER, defaultValue: 1 },
                            DURATION: { type: Scratch.ArgumentType.NUMBER, defaultValue: 0.2 },
                            STRENGTH: { type: Scratch.ArgumentType.NUMBER, defaultValue: 1 }
                        }
                    }
                ],
                menus: {
                    buttons: {
                        acceptReporters: true,
                        items: [
                            'A', 'B', 'X', 'Y', 'Cross', 'Circle', 'Square', 'Triangle',
                            'LB', 'RB', 'LT', 'RT', 'L1', 'R1', 'L2', 'R2',
                            'Back', 'Start', 'L3', 'R3', 'DPad Up', 'DPad Down',
                            'DPad Left', 'DPad Right', 'Home', 'Guide', 'Touchpad'
                        ]
                    },
                    sticks: ['Left stick', 'Right stick'],
                    directions: ['X', 'Y']
                }
            };
        }

        controllerCount() {
            this.refresh();
            return this.gamepads.length;
        }

        controllerName(args) {
            const pad = this.getPad(args.CONTROLLER);
            return pad ? pad.id : '';
        }

        controllerType(args) {
            const pad = this.getPad(args.CONTROLLER);
            if (!pad) return 'None';
            const id = pad.id.toLowerCase();
            if (id.includes('dualsense') || id.includes('wireless controller') || id.includes('054c')) return 'DualSense / PlayStation';
            if (id.includes('xbox') || id.includes('xinput') || id.includes('045e')) return 'Xbox';
            return pad.mapping === 'standard' ? 'Standard gamepad' : 'Gamepad';
        }

        buttonPressed(args) {
            return this.buttonPressed(this.getPad(args.CONTROLLER), args.BUTTON);
        }

        buttonValue(args) {
            return this.buttonValue(this.getPad(args.CONTROLLER), args.BUTTON);
        }

        axisValue(args) {
            return this.axisValue(this.getPad(args.CONTROLLER), Number(args.AXIS) - 1);
        }

        stickValue(args) {
            const pad = this.getPad(args.CONTROLLER);
            const stick = String(args.STICK).toLowerCase().startsWith('right') ? 2 : 0;
            const axis = stick + (String(args.DIRECTION).toUpperCase() === 'Y' ? 1 : 0);
            return this.axisValue(pad, axis);
        }

        anyButtonPressed(args) {
            const pad = this.getPad(args.CONTROLLER);
            return !!(pad && pad.buttons.some(button => button.pressed));
        }

        buttonJustPressed(args) {
            const pad = this.getPad(args.CONTROLLER);
            if (!pad) return false;
            const index = this.buttonIndex(args.BUTTON);
            const current = !!(pad.buttons[index] && pad.buttons[index].pressed);
            const previous = (this.previousButtons.get(pad.index) || [])[index] || false;
            return current && !previous;
        }

        async rumble(args) {
            const pad = this.getPad(args.CONTROLLER);
            if (!pad || !pad.vibrationActuator || typeof pad.vibrationActuator.playEffect !== 'function') return;
            const duration = Math.max(0, Math.min(10000, Number(args.DURATION) * 1000 || 0));
            const strength = Math.max(0, Math.min(1, Number(args.STRENGTH)));
            try {
                await pad.vibrationActuator.playEffect('dual-rumble', {
                    startDelay: 0,
                    duration,
                    weakMagnitude: strength,
                    strongMagnitude: strength
                });
            } catch (_) {
                // Rumble is optional and browser/controller support varies.
            }
        }
    }

    Scratch.extensions.register(new ControllerExtension());
})(Scratch);
