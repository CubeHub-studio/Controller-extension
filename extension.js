/* CubeHub Controller Extension for Gandi IDE / Scratch-compatible editors.
 *
 * Uses:
 *   - W3C Gamepad API for controller input/haptics.
 *   - WebHID (Chromium only) for optional DualSense lightbar control.
 *
 * The Gamepad API standardizes a "standard" layout, but it does NOT standardize
 * controller LEDs. DualSense lighting therefore uses its vendor-specific HID
 * output protocol through WebHID.
 */
(function (Scratch) {
    'use strict';

    if (!Scratch.extensions.unsandboxed) {
        throw new Error('CubeHub Controller requires an unsandboxed extension.');
    }

    class ControllerExtension {
        constructor() {
            this.gamepads = new Map();
            this.previousButtons = new Map();
            this.currentButtons = new Map();
            this.frame = 0;

            // WebHID DualSense state.
            this.dualSenseHid = null;
            this.dualSenseConnection = null;
            this.dualSenseSequence = 0;

            window.addEventListener('gamepadconnected', e => {
                // Do not write input state here. The polling loop owns state
                // transitions, preventing a connect event from making a button
                // appear "already pressed" or destroying just-pressed detection.
                this.poll();
            });

            window.addEventListener('gamepaddisconnected', e => {
                if (e.gamepad) this.removeGamepadByIndex(e.gamepad.index);
            });

            this.startPolling();
        }

        startPolling() {
            const loop = () => {
                this.poll();
                requestAnimationFrame(loop);
            };
            requestAnimationFrame(loop);
        }

        readButton(button) {
            if (button == null) return false;
            if (typeof button === 'object') {
                return !!button.pressed || Number(button.value) >= 0.5;
            }
            return Number(button) >= 0.5;
        }

        readButtonValue(button) {
            if (button == null) return 0;
            if (typeof button === 'object') {
                const value = Number(button.value);
                return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : (button.pressed ? 1 : 0);
            }
            const value = Number(button);
            return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
        }

        poll() {
            this.frame++;

            const pads = navigator.getGamepads ? navigator.getGamepads() : [];
            const active = new Set();

            for (const pad of pads) {
                if (!pad || pad.connected === false) continue;

                active.add(pad.index);

                const old = this.currentButtons.get(pad.index) || [];
                const current = Array.from(pad.buttons || [], b => this.readButton(b));

                // Exactly one state transition per animation frame.
                this.previousButtons.set(pad.index, old.slice());
                this.currentButtons.set(pad.index, current);
                this.gamepads.set(pad.index, pad);
            }

            for (const index of Array.from(this.gamepads.keys())) {
                if (!active.has(index)) this.removeGamepadByIndex(index);
            }
        }

        removeGamepadByIndex(index) {
            this.gamepads.delete(index);
            this.previousButtons.delete(index);
            this.currentButtons.delete(index);
        }

        getPads() {
            return Array.from(this.gamepads.values()).sort((a, b) => a.index - b.index);
        }

        getPad(which) {
            const n = Math.max(1, Math.floor(Number(which) || 1));
            return this.getPads()[n - 1] || null;
        }

        cleanName(name) {
            return String(name || '').toLowerCase().replace(/[ _-]/g, '');
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

                back: 8, select: 8, share: 8, create: 8, view: 8,
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

            const key = this.cleanName(name);
            if (Object.prototype.hasOwnProperty.call(aliases, key)) return aliases[key];

            const n = Number(name);
            return Number.isInteger(n) && n >= 0 ? n : -1;
        }

        getButtonState(pad, index) {
            if (!pad || index < 0) return false;
            const state = this.currentButtons.get(pad.index);
            return !!(state && state[index]);
        }

        getButtonValue(pad, index) {
            if (!pad || index < 0 || !pad.buttons[index]) return 0;
            return this.readButtonValue(pad.buttons[index]);
        }

        controllerType(pad) {
            if (!pad) return 'None';

            const id = String(pad.id || '').toLowerCase();

            if (
                id.includes('dualsense') ||
                id.includes('dual sense') ||
                id.includes('wireless controller') && id.includes('054c') ||
                id.includes('054c')
            ) return 'PlayStation';

            if (
                id.includes('xbox') ||
                id.includes('xinput') ||
                id.includes('045e')
            ) return 'Xbox';

            return pad.mapping === 'standard' ? 'Standard gamepad' : 'Gamepad';
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
                        text: 'controllers connected'
                    },
                    {
                        opcode: 'controllerName',
                        blockType: Scratch.BlockType.REPORTER,
                        text: 'controller [CONTROLLER] name',
                        arguments: {
                            CONTROLLER: { type: Scratch.ArgumentType.NUMBER, defaultValue: 1 }
                        }
                    },
                    {
                        opcode: 'controllerTypeBlock',
                        blockType: Scratch.BlockType.REPORTER,
                        text: 'controller [CONTROLLER] type',
                        arguments: {
                            CONTROLLER: { type: Scratch.ArgumentType.NUMBER, defaultValue: 1 }
                        }
                    },
                    {
                        opcode: 'buttonName',
                        blockType: Scratch.BlockType.REPORTER,
                        text: 'controller [CONTROLLER] button [BUTTON] name',
                        arguments: {
                            CONTROLLER: { type: Scratch.ArgumentType.NUMBER, defaultValue: 1 },
                            BUTTON: { type: Scratch.ArgumentType.STRING, menu: 'physicalButtons', defaultValue: '1' }
                        }
                    },
                    {
                        opcode: 'controllerMapping',
                        blockType: Scratch.BlockType.REPORTER,
                        text: 'controller [CONTROLLER] mapping',
                        arguments: {
                            CONTROLLER: { type: Scratch.ArgumentType.NUMBER, defaultValue: 1 }
                        }
                    },
                    '---',
                    {
                        opcode: 'buttonPressed',
                        blockType: Scratch.BlockType.BOOLEAN,
                        text: 'controller [CONTROLLER] [BUTTON] pressed?',
                        arguments: {
                            CONTROLLER: { type: Scratch.ArgumentType.NUMBER, defaultValue: 1 },
                            BUTTON: {
                                type: Scratch.ArgumentType.STRING,
                                menu: 'buttons',
                                defaultValue: 'A'
                            }
                        }
                    },
                    {
                        opcode: 'buttonJustPressed',
                        blockType: Scratch.BlockType.BOOLEAN,
                        text: 'controller [CONTROLLER] [BUTTON] just pressed?',
                        arguments: {
                            CONTROLLER: { type: Scratch.ArgumentType.NUMBER, defaultValue: 1 },
                            BUTTON: {
                                type: Scratch.ArgumentType.STRING,
                                menu: 'buttons',
                                defaultValue: 'A'
                            }
                        }
                    },
                    {
                        opcode: 'buttonValue',
                        blockType: Scratch.BlockType.REPORTER,
                        text: 'controller [CONTROLLER] [BUTTON] value',
                        arguments: {
                            CONTROLLER: { type: Scratch.ArgumentType.NUMBER, defaultValue: 1 },
                            BUTTON: {
                                type: Scratch.ArgumentType.STRING,
                                menu: 'buttons',
                                defaultValue: 'A'
                            }
                        }
                    },
                    {
                        opcode: 'anyButtonPressed',
                        blockType: Scratch.BlockType.BOOLEAN,
                        text: 'controller [CONTROLLER] any button pressed?',
                        arguments: {
                            CONTROLLER: { type: Scratch.ArgumentType.NUMBER, defaultValue: 1 }
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
                            STICK: {
                                type: Scratch.ArgumentType.STRING,
                                menu: 'sticks',
                                defaultValue: 'Left stick'
                            },
                            DIRECTION: {
                                type: Scratch.ArgumentType.STRING,
                                menu: 'directions',
                                defaultValue: 'X'
                            }
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
                    },
                    '---',
                    {
                        opcode: 'connectDualSense',
                        blockType: Scratch.BlockType.COMMAND,
                        text: 'connect DualSense for lights'
                    },
                    {
                        opcode: 'dualSenseConnected',
                        blockType: Scratch.BlockType.BOOLEAN,
                        text: 'DualSense lights connected?'
                    },
                    {
                        opcode: 'setDualSenseLight',
                        blockType: Scratch.BlockType.COMMAND,
                        text: 'set DualSense light R [RED] G [GREEN] B [BLUE]',
                        arguments: {
                            RED: { type: Scratch.ArgumentType.NUMBER, defaultValue: 255 },
                            GREEN: { type: Scratch.ArgumentType.NUMBER, defaultValue: 0 },
                            BLUE: { type: Scratch.ArgumentType.NUMBER, defaultValue: 0 }
                        }
                    },
                    {
                        opcode: 'setDualSenseLightOff',
                        blockType: Scratch.BlockType.COMMAND,
                        text: 'turn DualSense light off'
                    },
                    {
                        opcode: 'setAdaptiveTriggerMode',
                        blockType: Scratch.BlockType.COMMAND,
                        text: 'Adaptive trigger mode controller [CONTROLLER] trigger [TRIGGER] set [MODE]',
                        arguments: {
                            CONTROLLER: { type: Scratch.ArgumentType.NUMBER, defaultValue: 1 },
                            TRIGGER: { type: Scratch.ArgumentType.STRING, menu: 'adaptiveTriggers', defaultValue: 'L' },
                            MODE: { type: Scratch.ArgumentType.STRING, menu: 'adaptiveTriggerModes', defaultValue: 'Off' }
                        }
                    }
                ],

                menus: {
                    physicalButtons: {
                        acceptReporters: true,
                        items: Array.from({ length: 18 }, (_, i) => String(i + 1))
                    },
                    buttons: {
                        acceptReporters: true,
                        items: [
                            'A', 'B', 'X', 'Y',
                            'Cross', 'Circle', 'Square', 'Triangle',
                            'LB', 'RB', 'LT', 'RT',
                            'L1', 'R1', 'L2', 'R2',
                            'Back / Share', 'Start / Options',
                            'L3', 'R3',
                            'DPad Up', 'DPad Down',
                            'DPad Left', 'DPad Right',
                            'Guide / PS', 'Touchpad'
                        ]
                    },
                    sticks: ['Left stick', 'Right stick'],
                    directions: ['X', 'Y'],
                    adaptiveTriggers: ['L', 'R'],
                    adaptiveTriggerModes: [
                        'Off',
                        'Feedback',
                        'Weapon',
                        'Vibration',
                        'Slope Feedback',
                        'Multiple-Position Feedback',
                        'Multiple-Position Vibration',
                        'GameCube Emulation',
                        'Machine Gun / Automatic',
                        'Galloping',
                        'Pistol / Semi-Automatic',
                        'Rifle / Bow & Arrow',
                        'Choppy',
                        'Soft',
                        'Medium',
                        'Max',
                        'Pulse / Tension Guard',
                        'Rumble Transmission',
                        'Calibration'
                    ]
                }
            };
        }

        controllerCount() {
            return this.gamepads.size;
        }

        controllerName(args) {
            const p = this.getPad(args.CONTROLLER);
            return p ? String(p.id || '') : '';
        }

        controllerTypeBlock(args) {
            return this.controllerType(this.getPad(args.CONTROLLER));
        }

        buttonName(args) {
            const p = this.getPad(args.CONTROLLER);
            if (!p) return '';

            const i = Math.floor(Number(args.BUTTON) || 1) - 1;
            if (i < 0 || i >= (p.buttons || []).length) return '';

            const type = this.controllerType(p);
            const names = type === 'PlayStation'
                ? ['Cross', 'Circle', 'Square', 'Triangle', 'L1', 'R1', 'L2', 'R2', 'Create / Share', 'Options / Menu', 'L3', 'R3', 'DPad Up', 'DPad Down', 'DPad Left', 'DPad Right', 'PS', 'Touchpad']
                : type === 'Xbox'
                ? ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'View / Back', 'Menu / Start', 'LS', 'RS', 'DPad Up', 'DPad Down', 'DPad Left', 'DPad Right', 'Xbox Guide', 'Extra']
                : Array.from({ length: p.buttons.length }, (_, n) => 'Button ' + (n + 1));

            return names[i] || ('Button ' + (i + 1));
        }

        controllerMapping(args) {
            const p = this.getPad(args.CONTROLLER);
            return p ? (p.mapping || '') : '';
        }

        buttonPressed(args) {
            return this.getButtonState(
                this.getPad(args.CONTROLLER),
                this.buttonIndex(args.BUTTON)
            );
        }

        buttonJustPressed(args) {
            const p = this.getPad(args.CONTROLLER);
            const i = this.buttonIndex(args.BUTTON);
            if (!p || i < 0) return false;

            const current = this.getButtonState(p, i);
            const previous = !!((this.previousButtons.get(p.index) || [])[i]);

            return current && !previous;
        }

        buttonValue(args) {
            return this.getButtonValue(
                this.getPad(args.CONTROLLER),
                this.buttonIndex(args.BUTTON)
            );
        }

        anyButtonPressed(args) {
            const p = this.getPad(args.CONTROLLER);
            const buttons = p ? (this.currentButtons.get(p.index) || []) : [];
            return buttons.some(Boolean);
        }

        axisValue(args) {
            const p = this.getPad(args.CONTROLLER);
            const n = Math.max(1, Math.floor(Number(args.AXIS) || 1)) - 1;
            return p && Number.isFinite(p.axes[n]) ? p.axes[n] : 0;
        }

        stickValue(args) {
            const p = this.getPad(args.CONTROLLER);
            if (!p) return 0;

            const right = String(args.STICK).toLowerCase().startsWith('right');
            const y = String(args.DIRECTION).toUpperCase() === 'Y';
            const axis = (right ? 2 : 0) + (y ? 1 : 0);

            return Number.isFinite(p.axes[axis]) ? p.axes[axis] : 0;
        }

        async rumble(args) {
            const p = this.getPad(args.CONTROLLER);
            if (!p) return;

            const actuator =
                p.vibrationActuator ||
                (Array.isArray(p.hapticActuators) ? p.hapticActuators[0] : null);

            if (!actuator) return;

            const duration = Math.max(
                0,
                Math.min(10000, Number(args.DURATION) * 1000 || 0)
            );
            const strength = Math.max(
                0,
                Math.min(1, Number(args.STRENGTH))
            );

            try {
                if (
                    Array.isArray(actuator.effects) &&
                    actuator.effects.includes('dual-rumble') &&
                    typeof actuator.playEffect === 'function'
                ) {
                    await actuator.playEffect('dual-rumble', {
                        startDelay: 0,
                        duration,
                        weakMagnitude: strength,
                        strongMagnitude: strength
                    });
                } else if (typeof actuator.pulse === 'function') {
                    await actuator.pulse(strength, duration);
                }
            } catch (_) {
                // Haptics are optional and browser/controller support varies.
            }
        }

        // ---------------- WebHID DualSense lightbar ----------------

        async connectDualSense() {
            if (!('hid' in navigator)) return false;

            try {
                const devices = await navigator.hid.requestDevice({
                    filters: [
                        {
                            vendorId: 0x054c,
                            usagePage: 0x0001,
                            usage: 0x0005
                        }
                    ]
                });

                const device = devices && devices[0];
                if (!device) return false;

                if (!device.opened) await device.open();

                this.dualSenseHid = device;
                this.dualSenseConnection = this.detectDualSenseTransport(device);
                return true;
            } catch (_) {
                return false;
            }
        }

        detectDualSenseTransport(device) {
            // WebHID report data excludes the report ID.
            // DualSense USB input is 63 bytes; Bluetooth input is 77 bytes.
            let maxInput = 0;

            for (const collection of (device.collections || [])) {
                for (const report of (collection.inputReports || [])) {
                    let bits = 0;
                    for (const item of (report.items || [])) {
                        bits += Number(item.reportSize || 0) * Number(item.reportCount || 0);
                    }
                    maxInput = Math.max(maxInput, Math.ceil(bits / 8));
                }
            }

            if (maxInput >= 77) return 'bluetooth';
            if (maxInput >= 63) return 'usb';

            // Some Chromium/device combinations expose incomplete collection
            // metadata. USB is the safer fallback because it does not need CRC.
            return 'usb';
        }

        dualSenseConnected() {
            return !!(
                this.dualSenseHid &&
                this.dualSenseHid.opened &&
                this.dualSenseHid.vendorId === 0x054c
            );
        }

        clampByte(value) {
            const n = Number(value);
            if (!Number.isFinite(n)) return 0;
            return Math.max(0, Math.min(255, Math.round(n)));
        }

        crc32(bytes) {
            let crc = 0xFFFFFFFF;

            for (const byte of bytes) {
                crc ^= byte;
                for (let i = 0; i < 8; i++) {
                    crc = (crc >>> 1) ^ ((crc & 1) ? 0xEDB88320 : 0);
                }
            }

            return (crc ^ 0xFFFFFFFF) >>> 0;
        }

        fillBluetoothChecksum(reportId, data) {
            // CRC is over 0xA2, report ID, and every byte except the final 4.
            const input = new Uint8Array(2 + data.length - 4);
            input[0] = 0xA2;
            input[1] = reportId;
            input.set(data.subarray(0, data.length - 4), 2);

            const crc = this.crc32(input);

            data[data.length - 4] = crc & 0xFF;
            data[data.length - 3] = (crc >>> 8) & 0xFF;
            data[data.length - 2] = (crc >>> 16) & 0xFF;
            data[data.length - 1] = (crc >>> 24) & 0xFF;
        }

        async sendDualSenseOutput(configure) {
            if (!this.dualSenseConnected()) return false;

            try {
                let reportId;
                let data;
                let common;

                if (this.dualSenseConnection === 'bluetooth') {
                    reportId = 0x31;
                    data = new Uint8Array(77);
                    data[0] = (this.dualSenseSequence & 0x0F) << 4;
                    data[1] = 0x10;
                    this.dualSenseSequence = (this.dualSenseSequence + 1) & 0x0F;
                    common = data.subarray(2, 49);
                } else {
                    reportId = 0x02;
                    data = new Uint8Array(47);
                    common = data;
                }

                // Keep the complete common report zeroed except for fields we set.
                common[0] = 0xFF; // valid haptics/compatibility flags
                configure(common);

                if (this.dualSenseConnection === 'bluetooth') {
                    this.fillBluetoothChecksum(reportId, data);
                }

                await this.dualSenseHid.sendReport(reportId, data);
                return true;
            } catch (_) {
                return false;
            }
        }

        async setDualSenseLight(args) {
            if (!this.dualSenseConnected()) return false;

            const r = this.clampByte(args.RED);
            const g = this.clampByte(args.GREEN);
            const b = this.clampByte(args.BLUE);

            // The DualSense common output report puts lightbar RGB at offsets
            // 44, 45, 46. The previous implementation used offsets from an
            // older/incomplete report layout, which is why Chrome could pair
            // with the controller but the LEDs did not change.
            return this.sendDualSenseOutput(common => {
                common[1] |= 0x04; // LIGHTBAR_CONTROL_ENABLE
                common[38] |= 0x02; // LIGHTBAR_SETUP_CONTROL_ENABLE
                common[41] = 0x01; // LIGHT_ON
                common[42] = 0x00; // brightness: full/default
                common[44] = r;
                common[45] = g;
                common[46] = b;
            });
        }

        async setDualSenseLightOff() {
            if (!this.dualSenseConnected()) return false;

            return this.sendDualSenseOutput(common => {
                common[38] |= 0x02; // LIGHTBAR_SETUP_CONTROL_ENABLE
                common[41] = 0x02; // LIGHT_OUT
            });
        }

        async requireDualSenseHidForTriggers() {
            if (!('hid' in navigator)) return false;

            if (this.dualSenseConnected()) return true;

            try {
                // Adaptive triggers are vendor-specific HID output features.
                // Do not fall back to the Gamepad API for trigger effects.
                const devices = await navigator.hid.getDevices();
                let device = devices.find(d =>
                    d.vendorId === 0x054c &&
                    (!d.productId || d.productId === 0x0ce6 || d.productId === 0x0df2)
                );

                if (!device) {
                    const requested = await navigator.hid.requestDevice({
                        filters: [{ vendorId: 0x054c }]
                    });
                    device = requested && requested[0];
                }

                if (!device || device.vendorId !== 0x054c) return false;
                if (!device.opened) await device.open();

                this.dualSenseHid = device;
                this.dualSenseConnection = this.detectDualSenseTransport(device);
                return true;
            } catch (_) {
                return false;
            }
        }

        writeTriggerFeedback(effect, trigger) {
            const offset = trigger === 'R' ? 10 : 20;
            for (let i = 0; i < 10; i++) effect[offset + i] = 0;
        }

        setTriggerFeedback(effect, position, strength) {
            position = Math.max(0, Math.min(9, Math.floor(position)));
            strength = Math.max(0, Math.min(8, Math.floor(strength)));

            effect.fill(0);
            if (strength <= 0) {
                effect[0] = 0x05;
                return;
            }

            let activeZones = 0;
            let forceZones = 0;
            const forceValue = (strength - 1) & 0x07;

            for (let i = position; i < 10; i++) {
                activeZones |= (1 << i);
                forceZones |= forceValue << (3 * i);
            }

            effect[0] = 0x21;
            effect[1] = activeZones & 0xFF;
            effect[2] = (activeZones >>> 8) & 0xFF;
            effect[3] = forceZones & 0xFF;
            effect[4] = (forceZones >>> 8) & 0xFF;
            effect[5] = (forceZones >>> 16) & 0xFF;
            effect[6] = (forceZones >>> 24) & 0xFF;
        }

        setTriggerWeapon(effect, start, end, strength) {
            start = Math.max(2, Math.min(7, Math.floor(start)));
            end = Math.max(start + 1, Math.min(8, Math.floor(end)));
            strength = Math.max(0, Math.min(8, Math.floor(strength)));
            effect.fill(0);
            if (strength <= 0) { effect[0] = 0x05; return; }
            const zones = (1 << start) | (1 << end);
            effect[0] = 0x25;
            effect[1] = zones & 0xFF;
            effect[2] = (zones >>> 8) & 0xFF;
            effect[3] = (strength - 1) & 0x07;
        }

        setTriggerBow(effect, start, end, strength, snapForce) {
            start = Math.max(0, Math.min(8, Math.floor(start)));
            end = Math.max(start + 1, Math.min(8, Math.floor(end)));
            strength = Math.max(0, Math.min(8, Math.floor(strength)));
            snapForce = Math.max(0, Math.min(8, Math.floor(snapForce)));
            effect.fill(0);
            if (!strength || !snapForce || end <= 0) { effect[0] = 0x05; return; }
            const zones = (1 << start) | (1 << end);
            const forcePair = ((strength - 1) & 0x07) | (((snapForce - 1) & 0x07) << 3);
            effect[0] = 0x22;
            effect[1] = zones & 0xFF;
            effect[2] = (zones >>> 8) & 0xFF;
            effect[3] = forcePair & 0xFF;
            effect[4] = (forcePair >>> 8) & 0xFF;
        }

        setTriggerGalloping(effect, start, end, firstFoot, secondFoot, frequency) {
            start = Math.max(0, Math.min(8, Math.floor(start)));
            end = Math.max(start + 1, Math.min(9, Math.floor(end)));
            firstFoot = Math.max(0, Math.min(6, Math.floor(firstFoot)));
            secondFoot = Math.max(firstFoot + 1, Math.min(7, Math.floor(secondFoot)));
            frequency = Math.max(1, Math.min(255, Math.floor(frequency)));
            effect.fill(0);
            if (end <= start || secondFoot <= firstFoot || frequency <= 0) { effect[0] = 0x05; return; }
            const zones = (1 << start) | (1 << end);
            const timeAndRatio = (secondFoot & 7) | ((firstFoot & 7) << 3);
            effect[0] = 0x23;
            effect[1] = zones & 0xFF;
            effect[2] = (zones >>> 8) & 0xFF;
            effect[3] = timeAndRatio & 0xFF;
            effect[4] = frequency;
        }

        setSimpleFeedback(effect, position, strength) {
            effect.fill(0);
            position = Math.max(0, Math.min(255, Math.floor(position)));
            strength = Math.max(0, Math.min(255, Math.floor(strength)));
            effect[0] = 0x01;
            effect[1] = position;
            effect[2] = strength;
        }

        setTriggerVibration(effect, position, amplitude, frequency) {
            position = Math.max(0, Math.min(9, Math.floor(position)));
            amplitude = Math.max(0, Math.min(8, Math.floor(amplitude)));
            frequency = Math.max(1, Math.min(255, Math.floor(frequency)));

            effect.fill(0);
            if (amplitude <= 0) {
                effect[0] = 0x05;
                return;
            }

            let activeZones = 0;
            let amplitudeZones = 0;
            const amplitudeValue = (amplitude - 1) & 0x07;

            for (let i = position; i < 10; i++) {
                activeZones |= (1 << i);
                amplitudeZones |= amplitudeValue << (3 * i);
            }

            effect[0] = 0x26;
            effect[1] = activeZones & 0xFF;
            effect[2] = (activeZones >>> 8) & 0xFF;
            effect[3] = amplitudeZones & 0xFF;
            effect[4] = (amplitudeZones >>> 8) & 0xFF;
            effect[5] = (amplitudeZones >>> 16) & 0xFF;
            effect[6] = (amplitudeZones >>> 24) & 0xFF;
            effect[9] = frequency;
        }

        setTriggerMultipleFeedback(effect, strengths) {
            effect.fill(0);
            let activeZones = 0;
            let forceZones = 0;

            for (let i = 0; i < 10; i++) {
                const strength = Math.max(0, Math.min(8, Math.floor(strengths[i] || 0)));
                if (strength > 0) {
                    activeZones |= (1 << i);
                    forceZones |= ((strength - 1) & 0x07) << (3 * i);
                }
            }

            if (!activeZones) {
                effect[0] = 0x05;
                return;
            }

            effect[0] = 0x21;
            effect[1] = activeZones & 0xFF;
            effect[2] = (activeZones >>> 8) & 0xFF;
            effect[3] = forceZones & 0xFF;
            effect[4] = (forceZones >>> 8) & 0xFF;
            effect[5] = (forceZones >>> 16) & 0xFF;
            effect[6] = (forceZones >>> 24) & 0xFF;
        }

        setTriggerMultipleVibration(effect, amplitudes, frequency) {
            effect.fill(0);
            let activeZones = 0;
            let amplitudeZones = 0;

            for (let i = 0; i < 10; i++) {
                const amplitude = Math.max(0, Math.min(8, Math.floor(amplitudes[i] || 0)));
                if (amplitude > 0) {
                    activeZones |= (1 << i);
                    amplitudeZones |= ((amplitude - 1) & 0x07) << (3 * i);
                }
            }

            if (!activeZones || frequency <= 0) {
                effect[0] = 0x05;
                return;
            }

            effect[0] = 0x26;
            effect[1] = activeZones & 0xFF;
            effect[2] = (activeZones >>> 8) & 0xFF;
            effect[3] = amplitudeZones & 0xFF;
            effect[4] = (amplitudeZones >>> 8) & 0xFF;
            effect[5] = (amplitudeZones >>> 16) & 0xFF;
            effect[6] = (amplitudeZones >>> 24) & 0xFF;
            effect[9] = Math.max(1, Math.min(255, Math.floor(frequency)));
        }

        adaptiveTriggerMode(mode) {
            const modes = {
                'Off': 0x05,
                'Feedback': 0x21,
                'Weapon': 0x25,
                'Vibration': 0x26,
                'Slope Feedback': 0x21,
                'Multiple-Position Feedback': 0x21,
                'Multiple-Position Vibration': 0x26,
                'GameCube Emulation': 0x21,
                'Machine Gun / Automatic': 0x27,
                'Pistol / Semi-Automatic': 0x25,
                'Rifle / Bow & Arrow': 0x22,
                'Choppy': 0x21,
                'Soft': 0x21,
                'Medium': 0x21,
                'Max': 0x21,
                'Pulse / Tension Guard': 0x25,
                'Rumble Transmission': 0x26,
                'Calibration': 0x05
            };
            return Object.prototype.hasOwnProperty.call(modes, mode) ? modes[mode] : 0x05;
        }

        async setAdaptiveTriggerMode(args) {
            // Adaptive triggers are HID-only. The Gamepad API cannot send the
            // vendor-specific DualSense trigger effect report.
            if (!await this.requireDualSenseHidForTriggers()) return false;

            const controller = this.getPad(args.CONTROLLER);
            if (!controller || this.controllerType(controller) !== 'PlayStation') return false;

            const trigger = String(args.TRIGGER || 'L').toUpperCase() === 'R' ? 'R' : 'L';
            const modeName = String(args.MODE || 'Off');
            const effect = new Uint8Array(10);

            switch (modeName) {
                case 'Off':
                    effect[0] = 0x05;
                    break;
                case 'Feedback':
                    this.setTriggerFeedback(effect, 0, 6);
                    break;
                case 'Weapon':
                case 'Pistol / Semi-Automatic':
                    this.setTriggerWeapon(effect, 2, 7, 6);
                    break;
                case 'Vibration':
                    this.setTriggerVibration(effect, 0, 6, 40);
                    break;
                case 'Slope Feedback':
                    this.setTriggerMultipleFeedback(effect, [1, 2, 3, 4, 5, 6, 7, 7, 8, 8]);
                    break;
                case 'Multiple-Position Feedback':
                    this.setTriggerMultipleFeedback(effect, [2, 2, 4, 4, 6, 6, 8, 8, 5, 5]);
                    break;
                case 'Multiple-Position Vibration':
                    this.setTriggerMultipleVibration(effect, [2, 4, 6, 8, 6, 4, 2, 4, 6, 8], 35);
                    break;
                case 'GameCube Emulation':
                    this.setSimpleFeedback(effect, 0x55, 0x64);
                    break;
                case 'Machine Gun / Automatic': {
                    const zones = (1 << 1) | (1 << 9);
                    const amplitudePair = (2 & 7) | ((7 & 7) << 3);
                    effect[0] = 0x27;
                    effect[1] = zones & 0xFF;
                    effect[2] = (zones >>> 8) & 0xFF;
                    effect[3] = amplitudePair;
                    effect[4] = 18;
                    effect[5] = 2;
                    break;
                }
                case 'Galloping':
                    this.setTriggerGalloping(effect, 0, 9, 2, 5, 2);
                    break;
                case 'Pistol / Semi-Automatic':
                    this.setTriggerWeapon(effect, 2, 7, 6);
                    break;
                case 'Rifle / Bow & Arrow':
                    effect[0] = 0x26;
                    effect[1] = 0x00;
                    effect[2] = 0x03;
                    effect[3] = 0x00;
                    effect[4] = 0x00;
                    effect[5] = 0x00;
                    effect[6] = 0x3F;
                    effect[7] = 0x00;
                    effect[8] = 0x00;
                    effect[9] = 10;
                    break;
                case 'Choppy':
                    effect[0] = 0x21;
                    effect[1] = 0x02;
                    effect[2] = 0x27;
                    effect[3] = 0x18;
                    effect[4] = 0x00;
                    effect[5] = 0x00;
                    effect[6] = 0x26;
                    break;
                case 'Soft':
                    this.setSimpleFeedback(effect, 0x00, 0x00);
                    break;
                case 'Medium':
                    this.setSimpleFeedback(effect, 0x00, 0x64);
                    break;
                case 'Max':
                    this.setSimpleFeedback(effect, 0x00, 0xDC);
                    break;
                case 'Pulse / Tension Guard':
                    this.setSimpleFeedback(effect, 0x55, 0x64);
                    break;
                case 'Rumble Transmission':
                    this.setTriggerVibration(effect, 0, 5, 30);
                    break;
                case 'Calibration':
                    effect[0] = 0x05;
                    break;
                default:
                    effect[0] = 0x05;
                    break;
            }
            return this.sendDualSenseTriggerOutput(trigger, effect);
        }

        async sendDualSenseTriggerOutput(trigger, effect) {
            if (!this.dualSenseConnected()) return false;

            try {
                let reportId;
                let data;
                let common;

                if (this.dualSenseConnection === 'bluetooth') {
                    reportId = 0x31;
                    data = new Uint8Array(77);
                    data[0] = (this.dualSenseSequence & 0x0F) << 4;
                    data[1] = 0x10;
                    this.dualSenseSequence = (this.dualSenseSequence + 1) & 0x0F;
                    common = data.subarray(2, 49);
                } else {
                    reportId = 0x02;
                    data = new Uint8Array(47);
                    common = data;
                }

                // IMPORTANT: adaptive-trigger output must not enable the
                // compatibility-rumble bits in valid_flag0. Those bits can
                // route the controller into the old vibration path and prevent
                // the adaptive trigger actuators from responding.
                common[0] = trigger === 'R' ? 0x04 : 0x08;

                // WebHID strips the report ID from event data, and our Bluetooth
                // output buffer begins at the sequence byte. The DualSense
                // Bluetooth trigger fields are at common[10..19] (R2) and
                // common[23..32] (L2). USB uses common[10..19] and
                // common[21..30].
                const offset = trigger === 'R'
                    ? 10
                    : (this.dualSenseConnection === 'bluetooth' ? 23 : 21);
                for (let i = 0; i < 10; i++) {
                    common[offset + i] = effect[i] || 0;
                }

                if (this.dualSenseConnection === 'bluetooth') {
                    this.fillBluetoothChecksum(reportId, data);
                }

                await this.dualSenseHid.sendReport(reportId, data);
                return true;
            } catch (_) {
                return false;
            }
        }


    }

    Scratch.extensions.register(new ControllerExtension());
})(Scratch);
