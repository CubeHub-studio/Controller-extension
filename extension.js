/* CubeHub Controller Extension for Gandi IDE / Scratch-compatible editors. */
(function (Scratch) {
    'use strict';

    if (!Scratch.extensions.unsandboxed) {
        throw new Error('CubeHub Controller requires an unsandboxed extension.');
    }

    class ControllerExtension {
        constructor() {
            this.gamepads = [];
            this.previousButtons = new Map();
            this.currentButtons = new Map();
            window.addEventListener('gamepadconnected', () => this.refresh());
            window.addEventListener('gamepaddisconnected', () => this.refresh());
            this.poll();
        }

        poll() {
            const pads = navigator.getGamepads ? Array.from(navigator.getGamepads()) : [];
            this.gamepads = pads.filter(Boolean);
            for (const pad of this.gamepads) {
                const old = this.currentButtons.get(pad.index) || [];
                this.previousButtons.set(pad.index, old);
                this.currentButtons.set(pad.index, pad.buttons.map(b => !!b.pressed));
            }
            const active = new Set(this.gamepads.map(p => p.index));
            for (const index of this.currentButtons.keys()) {
                if (!active.has(index)) {
                    this.currentButtons.delete(index);
                    this.previousButtons.delete(index);
                }
            }
            requestAnimationFrame(() => this.poll());
        }

        refresh() {
            this.gamepads = navigator.getGamepads ? Array.from(navigator.getGamepads()).filter(Boolean) : [];
        }

        getPad(which) {
            this.refresh();
            const index = Math.max(1, Math.floor(Number(which) || 1)) - 1;
            return this.gamepads[index] || null;
        }

        isPlayStation(pad) {
            if (!pad) return false;
            const id = pad.id.toLowerCase();
            return id.includes('dualsense') || id.includes('dualshock') || id.includes('playstation') || id.includes('wireless controller') || id.includes('054c');
        }

        isXbox(pad) {
            if (!pad) return false;
            const id = pad.id.toLowerCase();
            return id.includes('xbox') || id.includes('xinput') || id.includes('045e');
        }

        buttonIndex(name, pad) {
            const key = String(name || '').toLowerCase().replace(/[ _-]/g, '');
            // Standard Gamepad API positions are physical positions, so the
            // same index works for Xbox A/B/X/Y and PlayStation Cross/Circle/
            // Square/Triangle when the controller exposes the standard mapping.
            const aliases = {
                a: 0, xboxa: 0,
                b: 1, xboxb: 1,
                xboxx: 2,
                y: 3, xboxy: 3,
                cross: 0, psx: 0,
                circle: 1, pso: 1,
                square: 2, pssquare: 2,
                triangle: 3, pstriangle: 3,
                lb: 4, l1: 4,
                rb: 5, r1: 5,
                lt: 6, l2: 6,
                rt: 7, r2: 7,
                back: 8, view: 8, select: 8,
                start: 9, menu: 9,
                l3: 10, leftstick: 10,
                r3: 11, rightstick: 11,
                dpadup: 12, up: 12,
                dpaddown: 13, down: 13,
                dpadleft: 14, left: 14,
                dpadright: 15, right: 15,
                home: 16, guide: 16,
                touchpad: 17, touchpadbutton: 17
            };
            if (Object.prototype.hasOwnProperty.call(aliases, key)) return aliases[key];
            const n = Number(name);
            return Number.isInteger(n) ? n : -1;
        }

        pressed(pad, name) {
            const i = this.buttonIndex(name, pad);
            return !!(pad && i >= 0 && pad.buttons[i] && pad.buttons[i].pressed);
        }

        value(pad, name) {
            const i = this.buttonIndex(name, pad);
            return pad && i >= 0 && pad.buttons[i] ? pad.buttons[i].value : 0;
        }

        buttonLabel(args) {
            const pad = this.getPad(args.CONTROLLER);
            const button = String(args.BUTTON || '');
            if (!pad) return '';
            return button;
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
                    { opcode: 'buttonPressed', blockType: Scratch.BlockType.BOOLEAN, text: 'controller [CONTROLLER] [BUTTON] pressed?', arguments: { CONTROLLER: { type: Scratch.ArgumentType.NUMBER, defaultValue: 1 }, BUTTON: { type: Scratch.ArgumentType.STRING, menu: 'buttons', defaultValue: 'A / Cross' } } },
                    { opcode: 'buttonValue', blockType: Scratch.BlockType.REPORTER, text: 'controller [CONTROLLER] [BUTTON] value', arguments: { CONTROLLER: { type: Scratch.ArgumentType.NUMBER, defaultValue: 1 }, BUTTON: { type: Scratch.ArgumentType.STRING, menu: 'buttons', defaultValue: 'A / Cross' } } },
                    { opcode: 'buttonJustPressed', blockType: Scratch.BlockType.BOOLEAN, text: 'controller [CONTROLLER] [BUTTON] just pressed?', arguments: { CONTROLLER: { type: Scratch.ArgumentType.NUMBER, defaultValue: 1 }, BUTTON: { type: Scratch.ArgumentType.STRING, menu: 'buttons', defaultValue: 'A / Cross' } } },
                    { opcode: 'anyButtonPressed', blockType: Scratch.BlockType.BOOLEAN, text: 'controller [CONTROLLER] any button pressed?', arguments: { CONTROLLER: { type: Scratch.ArgumentType.NUMBER, defaultValue: 1 } } },
                    '---',
                    { opcode: 'axisValue', blockType: Scratch.BlockType.REPORTER, text: 'controller [CONTROLLER] axis [AXIS]', arguments: { CONTROLLER: { type: Scratch.ArgumentType.NUMBER, defaultValue: 1 }, AXIS: { type: Scratch.ArgumentType.NUMBER, defaultValue: 1 } } },
                    { opcode: 'stickValue', blockType: Scratch.BlockType.REPORTER, text: 'controller [CONTROLLER] [STICK] [DIRECTION]', arguments: { CONTROLLER: { type: Scratch.ArgumentType.NUMBER, defaultValue: 1 }, STICK: { type: Scratch.ArgumentType.STRING, menu: 'sticks', defaultValue: 'Left stick' }, DIRECTION: { type: Scratch.ArgumentType.STRING, menu: 'directions', defaultValue: 'X' } } },
                    { opcode: 'rumble', blockType: Scratch.BlockType.COMMAND, text: 'rumble controller [CONTROLLER] for [DURATION] secs strength [STRENGTH]', arguments: { CONTROLLER: { type: Scratch.ArgumentType.NUMBER, defaultValue: 1 }, DURATION: { type: Scratch.ArgumentType.NUMBER, defaultValue: 0.2 }, STRENGTH: { type: Scratch.ArgumentType.NUMBER, defaultValue: 1 } } }
                ],
                menus: {
                    buttons: {
                        acceptReporters: true,
                        items: [
                            'A / Cross', 'B / Circle', 'X / Square', 'Y / Triangle',
                            'LB / L1', 'RB / R1', 'LT / L2', 'RT / R2',
                            'View / Share', 'Menu / Options', 'L3', 'R3',
                            'DPad Up', 'DPad Down', 'DPad Left', 'DPad Right',
                            'Guide / PS', 'Touchpad'
                        ]
                    },
                    sticks: ['Left stick', 'Right stick'],
                    directions: ['X', 'Y']
                }
            };
        }

        controllerCount() { this.refresh(); return this.gamepads.length; }
        controllerName(args) { const p = this.getPad(args.CONTROLLER); return p ? p.id : ''; }
        controllerType(args) {
            const p = this.getPad(args.CONTROLLER);
            if (!p) return 'None';
            if (this.isPlayStation(p)) return 'PlayStation';
            if (this.isXbox(p)) return 'Xbox';
            return 'Other';
        }

        buttonPressed(args) { return this.pressed(this.getPad(args.CONTROLLER), args.BUTTON); }
        buttonValue(args) { return this.value(this.getPad(args.CONTROLLER), args.BUTTON); }

        buttonJustPressed(args) {
            const p = this.getPad(args.CONTROLLER);
            if (!p) return false;
            const i = this.buttonIndex(args.BUTTON, p);
            return !!(p.buttons[i] && p.buttons[i].pressed) && !((this.previousButtons.get(p.index) || [])[i]);
        }

        anyButtonPressed(args) {
            const p = this.getPad(args.CONTROLLER);
            return !!(p && p.buttons.some(b => b.pressed));
        }

        axisValue(args) {
            const p = this.getPad(args.CONTROLLER);
            const i = Math.max(0, Math.floor(Number(args.AXIS) || 1) - 1);
            return p && Number.isFinite(p.axes[i]) ? p.axes[i] : 0;
        }

        stickValue(args) {
            const p = this.getPad(args.CONTROLLER);
            const base = String(args.STICK).toLowerCase().startsWith('right') ? 2 : 0;
            return p && Number.isFinite(p.axes[base + (String(args.DIRECTION).toUpperCase() === 'Y' ? 1 : 0)]) ? p.axes[base + (String(args.DIRECTION).toUpperCase() === 'Y' ? 1 : 0)] : 0;
        }

        async rumble(args) {
            const p = this.getPad(args.CONTROLLER);
            if (!p || !p.vibrationActuator || typeof p.vibrationActuator.playEffect !== 'function') return;
            const duration = Math.max(0, Math.min(10000, Number(args.DURATION) * 1000 || 0));
            const strength = Math.max(0, Math.min(1, Number(args.STRENGTH)));
            try { await p.vibrationActuator.playEffect('dual-rumble', { startDelay: 0, duration, weakMagnitude: strength, strongMagnitude: strength }); } catch (_) {}
        }
    }

    Scratch.extensions.register(new ControllerExtension());
})(Scratch);
