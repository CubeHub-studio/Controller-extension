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
            this.dualSenseLightColor = [255, 0, 0];

            // Persistent output state. Updating one feature must not erase the others.
            this.dualSenseOutput = {
                rumbleRight: 0,
                rumbleLeft: 0,
                muteLed: 0,
                playerLeds: 0,
                lightbar: [255, 0, 0],
                r2Effect: new Uint8Array([0x05, 0, 0, 0, 0, 0, 0, 0]),
                l2Effect: new Uint8Array([0x05, 0, 0, 0, 0, 0, 0, 0])
            };
            this.dualSenseLightBrightness = 255;

            // Raw DualSense input state. This is used when Chrome exposes the
            // controller through WebHID but does not expose it through the
            // Gamepad API (which can happen when WebHID owns the device).
            this.dualSenseRawButtons = new Array(18).fill(false);
            this.dualSenseRawPreviousButtons = new Array(18).fill(false);
            this.dualSenseRawAxes = [0, 0, 0, 0];
            this.dualSenseTouchX = 0;
            this.dualSenseTouchY = 0;
            this.dualSenseTouchTouched = false;
            this.dualSenseInputListener = null;
            this.dualSenseSyntheticIndex = 1000;
            this.dualSenseInputSeen = false;

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
            const pads = Array.from(this.gamepads.values())
                .sort((a, b) => a.index - b.index);

            // If WebHID has a DualSense open but the browser did not expose it
            // through navigator.getGamepads(), expose a synthetic gamepad to the
            // rest of the extension. This keeps the existing controller blocks
            // working instead of making HID-only DualSense a separate controller
            // system.
            const hasDualSenseGamepad = pads.some(p => this.controllerType(p) === 'PlayStation');

            if (!hasDualSenseGamepad && this.dualSenseConnected()) {
                pads.push({
                    id: '054c Sony Interactive Entertainment Wireless Controller (WebHID)',
                    index: this.dualSenseSyntheticIndex,
                    connected: true,
                    mapping: 'standard',
                    buttons: this.dualSenseRawButtons.map(pressed => ({
                        pressed: !!pressed,
                        value: pressed ? 1 : 0
                    })),
                    axes: this.dualSenseRawAxes.slice(),
                    hapticActuators: [],
                    vibrationActuator: null
                });
            }

            return pads.sort((a, b) => a.index - b.index);
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
            if (id.includes('xbox') || id.includes('xinput') || id.includes('045e')) return 'Xbox';
            return pad.mapping === 'standard' ? 'Standard gamepad' : 'Gamepad';
        }

        getInfo() {
            return {
                id: 'cubehubcontroller',
                name: 'Controller',
                color1: '#5865F2', color2: '#4752C4', color3: '#3C45A5',
                blocks: [
                    { opcode: 'controllerCount', blockType: Scratch.BlockType.REPORTER, text: 'controllers connected' },
                    { opcode: 'controllerName', blockType: Scratch.BlockType.REPORTER, text: 'controller [CONTROLLER] name', arguments: { CONTROLLER: { type: Scratch.ArgumentType.NUMBER, defaultValue: 1 } } },
                    { opcode: 'controllerTypeBlock', blockType: Scratch.BlockType.REPORTER, text: 'controller [CONTROLLER] type', arguments: { CONTROLLER: { type: Scratch.ArgumentType.NUMBER, defaultValue: 1 } } },
                    { opcode: 'buttonName', blockType: Scratch.BlockType.REPORTER, text: 'controller [CONTROLLER] button [BUTTON] name', arguments: { CONTROLLER: { type: Scratch.ArgumentType.NUMBER, defaultValue: 1 }, BUTTON: { type: Scratch.ArgumentType.STRING, menu: 'physicalButtons', defaultValue: '1' } } },
                    { opcode: 'controllerMapping', blockType: Scratch.BlockType.REPORTER, text: 'controller [CONTROLLER] mapping', arguments: { CONTROLLER: { type: Scratch.ArgumentType.NUMBER, defaultValue: 1 } } },
                    '---',
                    { opcode: 'buttonPressed', blockType: Scratch.BlockType.BOOLEAN, text: 'controller [CONTROLLER] [BUTTON] pressed?', arguments: { CONTROLLER: { type: Scratch.ArgumentType.NUMBER, defaultValue: 1 }, BUTTON: { type: Scratch.ArgumentType.STRING, menu: 'buttons', defaultValue: 'A' } } },
                    { opcode: 'buttonJustPressed', blockType: Scratch.BlockType.BOOLEAN, text: 'controller [CONTROLLER] [BUTTON] just pressed?', arguments: { CONTROLLER: { type: Scratch.ArgumentType.NUMBER, defaultValue: 1 }, BUTTON: { type: Scratch.ArgumentType.STRING, menu: 'buttons', defaultValue: 'A' } } },
                    { opcode: 'buttonValue', blockType: Scratch.BlockType.REPORTER, text: 'controller [CONTROLLER] [BUTTON] value', arguments: { CONTROLLER: { type: Scratch.ArgumentType.NUMBER, defaultValue: 1 }, BUTTON: { type: Scratch.ArgumentType.STRING, menu: 'buttons', defaultValue: 'A' } } },
                    { opcode: 'anyButtonPressed', blockType: Scratch.BlockType.BOOLEAN, text: 'controller [CONTROLLER] any button pressed?', arguments: { CONTROLLER: { type: Scratch.ArgumentType.NUMBER, defaultValue: 1 } } },
                    { opcode: 'touchpadX', blockType: Scratch.BlockType.REPORTER, text: 'controller [CONTROLLER] Touchpad X', arguments: { CONTROLLER: { type: Scratch.ArgumentType.NUMBER, defaultValue: 1 } } },
                    { opcode: 'touchpadY', blockType: Scratch.BlockType.REPORTER, text: 'controller [CONTROLLER] Touchpad Y', arguments: { CONTROLLER: { type: Scratch.ArgumentType.NUMBER, defaultValue: 1 } } },
                    { opcode: 'touchpadTouched', blockType: Scratch.BlockType.BOOLEAN, text: 'controller [CONTROLLER] Touchpad touched?', arguments: { CONTROLLER: { type: Scratch.ArgumentType.NUMBER, defaultValue: 1 } } },
                    { opcode: 'axisValue', blockType: Scratch.BlockType.REPORTER, text: 'controller [CONTROLLER] axis [AXIS]', arguments: { CONTROLLER: { type: Scratch.ArgumentType.NUMBER, defaultValue: 1 }, AXIS: { type: Scratch.ArgumentType.NUMBER, defaultValue: 1 } } },
                    { opcode: 'stickValue', blockType: Scratch.BlockType.REPORTER, text: 'controller [CONTROLLER] [STICK] [DIRECTION]', arguments: { CONTROLLER: { type: Scratch.ArgumentType.NUMBER, defaultValue: 1 }, STICK: { type: Scratch.ArgumentType.STRING, menu: 'sticks', defaultValue: 'Left stick' }, DIRECTION: { type: Scratch.ArgumentType.STRING, menu: 'directions', defaultValue: 'X' } } },
                    '---',
                    { opcode: 'rumble', blockType: Scratch.BlockType.COMMAND, text: 'rumble controller [CONTROLLER] for [DURATION] secs strength [STRENGTH]', arguments: { CONTROLLER: { type: Scratch.ArgumentType.NUMBER, defaultValue: 1 }, DURATION: { type: Scratch.ArgumentType.NUMBER, defaultValue: 0.2 }, STRENGTH: { type: Scratch.ArgumentType.NUMBER, defaultValue: 1 } } },
                    '---',
                    { opcode: 'searchForNewControllers', blockType: Scratch.BlockType.COMMAND, text: 'Search for new controllers' },
                    { opcode: 'requestHID', blockType: Scratch.BlockType.COMMAND, text: 'Request HID' },
                    { opcode: 'connectDualSense', blockType: Scratch.BlockType.COMMAND, text: 'connect DualSense for lights' },
                    { opcode: 'dualSenseConnected', blockType: Scratch.BlockType.BOOLEAN, text: 'DualSense lights connected?' },
                    { opcode: 'setDualSenseLight', blockType: Scratch.BlockType.COMMAND, text: 'set DualSense light R [RED] G [GREEN] B [BLUE] [TRANSITION]', arguments: { RED: { type: Scratch.ArgumentType.NUMBER, defaultValue: 255 }, GREEN: { type: Scratch.ArgumentType.NUMBER, defaultValue: 0 }, BLUE: { type: Scratch.ArgumentType.NUMBER, defaultValue: 0 }, TRANSITION: { type: Scratch.ArgumentType.STRING, menu: 'lightTransition', defaultValue: 'Instant' } } },
                    { opcode: 'setDualSenseLightBrightness', blockType: Scratch.BlockType.COMMAND, text: 'DualSense light brightness [BRIGHTNESS] [TRANSITION]', arguments: { BRIGHTNESS: { type: Scratch.ArgumentType.NUMBER, defaultValue: 255 }, TRANSITION: { type: Scratch.ArgumentType.STRING, menu: 'lightTransition', defaultValue: 'Instant' } } },
                    { opcode: 'setDualSenseLightOff', blockType: Scratch.BlockType.COMMAND, text: 'turn DualSense light off [TRANSITION]', arguments: { TRANSITION: { type: Scratch.ArgumentType.STRING, menu: 'lightTransition', defaultValue: 'Instant' } } },
                    { opcode: 'customAdaptiveTriggerEffect', blockType: Scratch.BlockType.COMMAND, text: 'Custom adaptive trigger controller [CONTROLLER] trigger [TRIGGER] mode [MODE] parameters [PARAMETERS]', arguments: { CONTROLLER: { type: Scratch.ArgumentType.NUMBER, defaultValue: 1 }, TRIGGER: { type: Scratch.ArgumentType.STRING, menu: 'adaptiveTriggers', defaultValue: 'L' }, MODE: { type: Scratch.ArgumentType.STRING, defaultValue: '0x21' }, PARAMETERS: { type: Scratch.ArgumentType.STRING, defaultValue: '255,255,255,255,255,255,0,0,0,0' } } },
                    { opcode: 'adaptiveTriggerModeNumber', blockType: Scratch.BlockType.REPORTER, text: '[NUMBER] adaptive trigger mode', arguments: { NUMBER: { type: Scratch.ArgumentType.NUMBER, defaultValue: 1 } } },
                    { opcode: 'setAdaptiveTriggerMode', blockType: Scratch.BlockType.COMMAND, text: 'Adaptive trigger mode controller [CONTROLLER] trigger [TRIGGER] set [MODE]', arguments: { CONTROLLER: { type: Scratch.ArgumentType.NUMBER, defaultValue: 1 }, TRIGGER: { type: Scratch.ArgumentType.STRING, menu: 'adaptiveTriggers', defaultValue: 'L' }, MODE: { type: Scratch.ArgumentType.STRING, menu: 'adaptiveTriggerModes', defaultValue: '1. Off' } } }
                ],
                menus: {
                    physicalButtons: { acceptReporters: true, items: Array.from({ length: 18 }, (_, i) => String(i + 1)) },
                    buttons: { acceptReporters: true, items: ['A','B','X','Y','Cross','Circle','Square','Triangle','LB','RB','LT','RT','L1','R1','L2','R2','Back / Share','Start / Options','L3','R3','DPad Up','DPad Down','DPad Left','DPad Right','Guide / PS','Touchpad'] },
                    sticks: ['Left stick','Right stick'], directions: ['X','Y'], adaptiveTriggers: ['L','R'], lightTransition: ['Fade','Instant'],
                    adaptiveTriggerModes: ['1. Off','2. Feedback','3. Weapon','4. Vibration','5. Slope Feedback','6. Multiple-Position Feedback','7. Multiple-Position Vibration','8. GameCube Emulation','9. Machine Gun / Automatic','10. Galloping','11. Pistol / Semi-Automatic','12. Rifle / Bow & Arrow','13. Choppy','14. Soft','15. Medium','16. Max','17. Pulse / Tension Guard','18. Rumble Transmission','19. Lock up','20. Calibration (MAY ALTER REAL CALIBRATION!)']
                }
            };
        }

        async searchForNewControllers() {
            this.poll();
            if ('hid' in navigator) {
                try {
                    const devices = await navigator.hid.getDevices();
                    const device = devices.find(d => this.isDualSenseHidDevice(d));
                    if (device) {
                        if (!device.opened) await device.open();
                        this.setDualSenseHidDevice(device);
                    }
                } catch (_) {}
            }
            this.poll();
        }

        async requestHID() {
            if (!('hid' in navigator)) return false;
            try {
                const devices = await navigator.hid.requestDevice({ filters: [{ vendorId: 0x054c }] });
                const device = devices && devices[0];
                if (!device) return false;
                if (!device.opened) await device.open();
                this.setDualSenseHidDevice(device);
                return true;
            } catch (_) { return false; }
        }

        isDualSenseHidDevice(device) {
            if (!device || Number(device.vendorId) !== 0x054c) return false;
            return (device.collections || []).some(c =>
                Number(c.usagePage) === 0x0001 && Number(c.usage) === 0x0005
            );
        }

        setDualSenseHidDevice(device) {
            if (!this.isDualSenseHidDevice(device)) return false;
            if (this.dualSenseHid && this.dualSenseInputListener) {
                try { this.dualSenseHid.removeEventListener('inputreport', this.dualSenseInputListener); } catch (_) {}
            }
            this.dualSenseHid = device;
            this.dualSenseConnection = this.detectDualSenseTransport(device);

            // Bluetooth DualSense: reading feature report 0x05 enables the full
            // 0x31 input report (touchpad, motion, etc.) after the device opens.
            if (this.dualSenseConnection === 'bluetooth' &&
                typeof device.receiveFeatureReport === 'function') {
                device.receiveFeatureReport(0x05).catch(() => {});
            }

            this.dualSenseInputSeen = false;
            this.dualSenseInputListener = event => this.handleDualSenseInputReport(event);
            device.addEventListener('inputreport', this.dualSenseInputListener);
            return true;
        }

        handleDualSenseInputReport(event) {
            if (!event || event.device !== this.dualSenseHid) return;
            const data = event.data;
            if (!data || data.byteLength < 7) return;
            const reportId = Number(event.reportId);
            let buttons0, buttons1, buttons2, axes;

            if (reportId === 0x01 && data.byteLength >= 63) {
                axes = [(data.getUint8(0)/127.5)-1,(data.getUint8(1)/127.5)-1,(data.getUint8(2)/127.5)-1,(data.getUint8(3)/127.5)-1];
                buttons0 = data.getUint8(7); buttons1 = data.getUint8(8); buttons2 = data.getUint8(9);
            } else if (reportId === 0x31 && data.byteLength >= 77) {
                axes = [(data.getUint8(1)/127.5)-1,(data.getUint8(2)/127.5)-1,(data.getUint8(3)/127.5)-1,(data.getUint8(4)/127.5)-1];
                buttons0 = data.getUint8(8); buttons1 = data.getUint8(9); buttons2 = data.getUint8(10);
            } else if (reportId === 0x01 && data.byteLength >= 9) {
                // Compact Bluetooth 0x01 report. WebHID strips the report ID.
                // Protocol bytes 6,7,8 become data[5],data[6],data[7].
                axes = [(data.getUint8(0)/127.5)-1,(data.getUint8(1)/127.5)-1,(data.getUint8(2)/127.5)-1,(data.getUint8(3)/127.5)-1];
                buttons0 = data.getUint8(4); buttons1 = data.getUint8(5); buttons2 = data.getUint8(6);
            } else return;

            const dpad = buttons0 & 0x0F;
            const next = [
                !!(buttons0 & 0x20), !!(buttons0 & 0x40), !!(buttons0 & 0x10), !!(buttons0 & 0x80),
                !!(buttons1 & 0x01), !!(buttons1 & 0x02), !!(buttons1 & 0x04), !!(buttons1 & 0x08),
                !!(buttons1 & 0x10), !!(buttons1 & 0x20), !!(buttons1 & 0x40), !!(buttons1 & 0x80),
                dpad === 0 || dpad === 1 || dpad === 7, dpad === 3 || dpad === 4 || dpad === 5,
                dpad === 5 || dpad === 6 || dpad === 7, dpad === 1 || dpad === 2 || dpad === 3,
                !!(buttons2 & 0x01), !!(buttons2 & 0x02)
            ];

            const touchOffset = reportId === 0x31 ? 33 : 33;
            let touchX = 0, touchY = 0, touchActive = false;
            if (data.byteLength >= touchOffset + 4) {
                const contact = data.getUint8(touchOffset);
                if ((contact & 0x80) === 0) {
                    touchX = data.getUint8(touchOffset + 1) | ((data.getUint8(touchOffset + 2) & 0x0F) << 8);
                    touchY = ((data.getUint8(touchOffset + 2) >> 4) & 0x0F) | (data.getUint8(touchOffset + 3) << 4);
                    touchActive = true;
                }
            }

            this.dualSenseRawPreviousButtons = this.dualSenseRawButtons.slice();
            this.dualSenseRawButtons = next;
            this.dualSenseRawAxes = axes.map(v => Math.max(-1, Math.min(1, v)));
            this.dualSenseTouchX = touchX;
            this.dualSenseTouchY = touchY;
            this.dualSenseTouchTouched = touchActive;
            this.dualSenseInputSeen = true;
            this.previousButtons.set(this.dualSenseSyntheticIndex, this.dualSenseRawPreviousButtons.slice());
            this.currentButtons.set(this.dualSenseSyntheticIndex, this.dualSenseRawButtons.slice());
        }

        controllerCount() { return this.getPads().length; }
        controllerName(args) { const p=this.getPad(args.CONTROLLER); return p ? String(p.id||'') : ''; }
        controllerTypeBlock(args) { const p=this.getPad(args.CONTROLLER); return this.controllerType(p); }
        buttonName(args) {
            const p=this.getPad(args.CONTROLLER); const i=Math.max(0,Math.floor(Number(args.BUTTON)||1)-1); if(!p) return '';
            const names=this.controllerType(p)==='PlayStation' ? ['Cross','Circle','Square','Triangle','L1','R1','L2','R2','Create / Share','Options','L3','R3','DPad Up','DPad Down','DPad Left','DPad Right','Guide / PS','Touchpad'] : ['A','B','X','Y','LB','RB','LT','RT','View / Back','Menu / Start','LS','RS','DPad Up','DPad Down','DPad Left','DPad Right','Xbox Guide','Extra'];
            return names[i] || ('Button ' + (i+1));
        }
        controllerMapping(args) { const p=this.getPad(args.CONTROLLER); return p ? (p.mapping||'') : ''; }
        buttonPressed(args) { return this.getButtonState(this.getPad(args.CONTROLLER),this.buttonIndex(args.BUTTON)); }
        buttonJustPressed(args) { const p=this.getPad(args.CONTROLLER), i=this.buttonIndex(args.BUTTON); if(!p||i<0)return false; return this.getButtonState(p,i) && !((this.previousButtons.get(p.index)||[])[i]); }
        buttonValue(args) { return this.getButtonValue(this.getPad(args.CONTROLLER),this.buttonIndex(args.BUTTON)); }
        anyButtonPressed(args) { const p=this.getPad(args.CONTROLLER); return p ? (this.currentButtons.get(p.index)||[]).some(Boolean) : false; }
        touchpadX(args) { const p=this.getPad(args.CONTROLLER); return !p||this.controllerType(p)!=='PlayStation' ? 0 : (this.dualSenseTouchX/1919)*480-240; }
        touchpadY(args) { const p=this.getPad(args.CONTROLLER); return !p||this.controllerType(p)!=='PlayStation' ? 0 : 180-(this.dualSenseTouchY/1079)*360; }
        touchpadTouched(args) { const p=this.getPad(args.CONTROLLER); return !!(p&&this.controllerType(p)==='PlayStation'&&this.dualSenseTouchTouched); }
        axisValue(args) { const p=this.getPad(args.CONTROLLER), n=Math.max(1,Math.floor(Number(args.AXIS)||1))-1; return p&&Number.isFinite(p.axes[n])?p.axes[n]:0; }
        stickValue(args) { const p=this.getPad(args.CONTROLLER); if(!p)return 0; const right=String(args.STICK).toLowerCase().startsWith('right'), y=String(args.DIRECTION).toUpperCase()==='Y', axis=(right?2:0)+(y?1:0); return Number.isFinite(p.axes[axis])?p.axes[axis]:0; }

        async rumble(args) {
            const duration=Math.max(0,Math.min(10000,Number(args.DURATION)*1000||0)), strength=Math.max(0,Math.min(1,Number(args.STRENGTH)));
            if(await this.requireDualSenseHidForTriggers()){ await this.sendDualSenseRumble(strength,duration); if(duration>0)setTimeout(()=>this.sendDualSenseRumble(0,0),duration); return; }
            const p=this.getPad(args.CONTROLLER); if(!p)return; const actuator=p.vibrationActuator||(Array.isArray(p.hapticActuators)?p.hapticActuators[0]:null); if(!actuator)return;
            try { if(Array.isArray(actuator.effects)&&actuator.effects.includes('dual-rumble')&&typeof actuator.playEffect==='function') await actuator.playEffect('dual-rumble',{startDelay:0,duration,weakMagnitude:strength,strongMagnitude:strength}); else if(typeof actuator.pulse==='function') await actuator.pulse(strength,duration); } catch(_){ }
        }

        async connectDualSense() {
            if(!('hid' in navigator))return false;
            try { const devices=await navigator.hid.requestDevice({filters:[{vendorId:0x054c,usagePage:0x0001,usage:0x0005}]}); const device=devices&&devices[0]; if(!device)return false; if(!device.opened)await device.open(); this.setDualSenseHidDevice(device); return true; } catch(_){return false;}
        }
        detectDualSenseTransport(device) {
            let maxInput=0; for(const collection of(device.collections||[]))for(const report of(collection.inputReports||[])){let bits=0;for(const item of(report.items||[]))bits+=Number(item.reportSize||0)*Number(item.reportCount||0);maxInput=Math.max(maxInput,Math.ceil(bits/8));}
            if(maxInput>=77)return 'bluetooth'; if(maxInput>=63)return 'usb'; return 'usb';
        }
        dualSenseConnected(){return !!(this.dualSenseHid&&this.dualSenseHid.opened&&this.dualSenseHid.vendorId===0x054c);}
        dualSenseConnectedBlock(){return this.dualSenseConnected();}
        clampByte(v){const n=Number(v);return Number.isFinite(n)?Math.max(0,Math.min(255,Math.round(n))):0;}
        crc32(bytes){let crc=0xFFFFFFFF;for(const byte of bytes){crc^=byte;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xEDB88320:0);}return(crc^0xFFFFFFFF)>>>0;}
        fillBluetoothChecksum(reportId,data){const input=new Uint8Array(2+data.length-4);input[0]=0xA2;input[1]=reportId;input.set(data.subarray(0,data.length-4),2);const crc=this.crc32(input);data[data.length-4]=crc&0xFF;data[data.length-3]=(crc>>>8)&0xFF;data[data.length-2]=(crc>>>16)&0xFF;data[data.length-1]=(crc>>>24)&0xFF;}
        buildDualSenseOutputReport() {
            let reportId, data, common;
            if (this.dualSenseConnection === 'bluetooth') {
                reportId = 0x31;
                data = new Uint8Array(77);
                data[0] = (this.dualSenseSequence & 0x0F) << 4;
                data[1] = 0x10;
                common = data.subarray(2, 49);
            } else {
                reportId = 0x02;
                data = new Uint8Array(47);
                common = data;
            }

            // valid_flag0: compatible vibration/haptics + R2/L2 trigger controls.
            common[0] = 0x0F;
            // valid_flag1: mute LED, power-save, lightbar and player indicators.
            common[1] = 0xF7;

            common[2] = this.dualSenseOutput.rumbleRight;
            common[3] = this.dualSenseOutput.rumbleLeft;
            common[8] = this.dualSenseOutput.muteLed;
            common[9] = this.dualSenseOutput.muteLed ? 0x00 : 0x10;

            // Correct 8-byte adaptive-trigger slots from DualSense Explorer.
            const r2Offset = this.dualSenseConnection === 'bluetooth' ? 12 : 10;
            const l2Offset = this.dualSenseConnection === 'bluetooth' ? 23 : 21;
            for (let i = 0; i < 8; i++) {
                common[r2Offset + i] = this.dualSenseOutput.r2Effect[i];
                common[l2Offset + i] = this.dualSenseOutput.l2Effect[i];
            }

            // Preserve the existing light implementation and its wire offsets.
            common[39] = 0x02;
            common[41] = 0x02;
            common[43] = this.dualSenseOutput.playerLeds;
            common[44] = this.dualSenseOutput.lightbar[0];
            common[45] = this.dualSenseOutput.lightbar[1];
            common[46] = this.dualSenseOutput.lightbar[2];

            if (this.dualSenseConnection === 'bluetooth')
                this.fillBluetoothChecksum(reportId, data);

            return { reportId, data };
        }

        async sendDualSenseOutput(configure) {
            if (!this.dualSenseConnected()) return false;
            try {
                if (typeof configure === 'function') configure(this.dualSenseOutput);
                const report = this.buildDualSenseOutputReport();
                await this.dualSenseHid.sendReport(report.reportId, report.data);
                this.dualSenseSequence = (this.dualSenseSequence + 1) & 0x0F;
                return true;
            } catch (_) {
                return false;
            }
        }

        async setDualSenseLightColor(r,g,b,transition){if(!this.dualSenseConnected())return false;r=this.clampByte(r);g=this.clampByte(g);b=this.clampByte(b);const start=this.dualSenseLightColor.slice(),steps=String(transition||'Instant')==='Fade'?10:1;for(let i=1;i<=steps;i++){const t=i/steps,cr=Math.round(start[0]+(r-start[0])*t),cg=Math.round(start[1]+(g-start[1])*t),cb=Math.round(start[2]+(b-start[2])*t);if(!await this.sendDualSenseOutput(state=>{state.lightbar=[cr,cg,cb];}))return false;if(steps>1&&i<steps)await new Promise(resolve=>setTimeout(resolve,30));}this.dualSenseLightColor=[r,g,b];return true;}
        async setDualSenseLight(args){const r=this.clampByte(args.RED),g=this.clampByte(args.GREEN),b=this.clampByte(args.BLUE);this.dualSenseLightBrightness=255;return this.setDualSenseLightColor(r,g,b,args.TRANSITION);}
        async setDualSenseLightBrightness(args){if(!this.dualSenseConnected())return false;const brightness=Math.max(0,Math.min(255,Math.floor(Number(args.BRIGHTNESS)||0)));this.dualSenseLightBrightness=brightness;const base=this.dualSenseLightColor.slice();return this.setDualSenseLightColor(Math.round(base[0]*brightness/255),Math.round(base[1]*brightness/255),Math.round(base[2]*brightness/255),args.TRANSITION);}
        async setDualSenseLightOff(args){if(!this.dualSenseConnected())return false;const mode=String(args&&args.TRANSITION||'Instant'),start=this.dualSenseLightColor.slice(),steps=mode==='Fade'?10:1;for(let i=1;i<=steps;i++){const t=i/steps;if(!await this.sendDualSenseOutput(state=>{state.lightbar=[Math.round(start[0]*(1-t)),Math.round(start[1]*(1-t)),Math.round(start[2]*(1-t))];}))return false;if(steps>1&&i<steps)await new Promise(resolve=>setTimeout(resolve,30));}return true;}
        async sendDualSenseRumble(strength,duration){if(!this.dualSenseConnected())return false;const motor=Math.round(Math.max(0,Math.min(1,Number(strength)||0))*255);return this.sendDualSenseOutput(state=>{state.rumbleRight=motor;state.rumbleLeft=motor;});}
        async requireDualSenseHidForTriggers(){if(!('hid'in navigator))return false;if(this.dualSenseConnected())return true;try{const devices=await navigator.hid.getDevices();let device=devices.find(d=>this.isDualSenseHidDevice(d));if(!device){const requested=await navigator.hid.requestDevice({filters:[{vendorId:0x054c}]});device=requested&&requested[0];}if(!device||!this.isDualSenseHidDevice(device))return false;if(!device.opened)await device.open();this.setDualSenseHidDevice(device);return true;}catch(_){return false;}}

        setTriggerFeedback(effect,position,strength){position=Math.max(0,Math.min(9,Math.floor(position)));strength=Math.max(0,Math.min(8,Math.floor(strength)));effect.fill(0);if(strength<=0){effect[0]=0x05;return;}let activeZones=0,forceZones=0,forceValue=(strength-1)&7;for(let i=position;i<10;i++){activeZones|=(1<<i);forceZones|=forceValue<<(3*i);}effect[0]=0x21;effect[1]=activeZones&255;effect[2]=(activeZones>>>8)&255;effect[3]=forceZones&255;effect[4]=(forceZones>>>8)&255;effect[5]=(forceZones>>>16)&255;effect[6]=(forceZones>>>24)&255;}
        setTriggerWeapon(effect,start,end,strength){start=Math.max(2,Math.min(7,Math.floor(start)));end=Math.max(start+1,Math.min(8,Math.floor(end)));strength=Math.max(0,Math.min(8,Math.floor(strength)));effect.fill(0);if(strength<=0){effect[0]=0x05;return;}const zones=(1<<start)|(1<<end);effect[0]=0x25;effect[1]=zones&255;effect[2]=(zones>>>8)&255;effect[3]=(strength-1)&7;}
        setTriggerBow(effect,start,end,strength,snapForce){start=Math.max(0,Math.min(8,Math.floor(start)));end=Math.max(start+1,Math.min(8,Math.floor(end)));strength=Math.max(0,Math.min(8,Math.floor(strength)));snapForce=Math.max(0,Math.min(8,Math.floor(snapForce)));effect.fill(0);if(!strength||!snapForce||end<=0){effect[0]=0x05;return;}const zones=(1<<start)|(1<<end),forcePair=((strength-1)&7)|(((snapForce-1)&7)<<3);effect[0]=0x22;effect[1]=zones&255;effect[2]=(zones>>>8)&255;effect[3]=forcePair&255;effect[4]=(forcePair>>>8)&255;}
        setTriggerGalloping(effect,start,end,firstFoot,secondFoot,frequency){start=Math.max(0,Math.min(8,Math.floor(start)));end=Math.max(start+1,Math.min(9,Math.floor(end)));firstFoot=Math.max(0,Math.min(6,Math.floor(firstFoot)));secondFoot=Math.max(firstFoot+1,Math.min(7,Math.floor(secondFoot)));frequency=Math.max(1,Math.min(255,Math.floor(frequency)));effect.fill(0);const zones=(1<<start)|(1<<end),timeAndRatio=(secondFoot&7)|((firstFoot&7)<<3);effect[0]=0x23;effect[1]=zones&255;effect[2]=(zones>>>8)&255;effect[3]=timeAndRatio;effect[4]=frequency;}
        setSimpleFeedback(effect,position,strength){effect.fill(0);effect[0]=0x01;effect[1]=Math.max(0,Math.min(255,Math.floor(position)));effect[2]=Math.max(0,Math.min(255,Math.floor(strength)));}
        setTriggerVibration(effect,position,amplitude,frequency){position=Math.max(0,Math.min(9,Math.floor(position)));amplitude=Math.max(0,Math.min(8,Math.floor(amplitude)));frequency=Math.max(1,Math.min(255,Math.floor(frequency)));effect.fill(0);if(amplitude<=0){effect[0]=0x05;return;}let activeZones=0,amplitudeZones=0,v=(amplitude-1)&7;for(let i=position;i<10;i++){activeZones|=1<<i;amplitudeZones|=v<<(3*i);}effect[0]=0x26;effect[1]=activeZones&255;effect[2]=(activeZones>>>8)&255;effect[3]=amplitudeZones&255;effect[4]=(amplitudeZones>>>8)&255;effect[5]=(amplitudeZones>>>16)&255;effect[6]=(amplitudeZones>>>24)&255;effect[7]=frequency;}
        setTriggerMultipleFeedback(effect,strengths){effect.fill(0);let activeZones=0,forceZones=0;for(let i=0;i<10;i++){const s=Math.max(0,Math.min(8,Math.floor(strengths[i]||0)));if(s>0){activeZones|=1<<i;forceZones|=((s-1)&7)<<(3*i);}}if(!activeZones){effect[0]=0x05;return;}effect[0]=0x21;effect[1]=activeZones&255;effect[2]=(activeZones>>>8)&255;effect[3]=forceZones&255;effect[4]=(forceZones>>>8)&255;effect[5]=(forceZones>>>16)&255;effect[6]=(forceZones>>>24)&255;}
        setTriggerMultipleVibration(effect,amplitudes,frequency){effect.fill(0);let activeZones=0,amplitudeZones=0;for(let i=0;i<10;i++){const a=Math.max(0,Math.min(8,Math.floor(amplitudes[i]||0)));if(a>0){activeZones|=1<<i;amplitudeZones|=((a-1)&7)<<(3*i);}}if(!activeZones||frequency<=0){effect[0]=0x05;return;}effect[0]=0x26;effect[1]=activeZones&255;effect[2]=(activeZones>>>8)&255;effect[3]=amplitudeZones&255;effect[4]=(amplitudeZones>>>8)&255;effect[5]=(amplitudeZones>>>16)&255;effect[6]=(amplitudeZones>>>24)&255;effect[7]=Math.max(1,Math.min(255,Math.floor(frequency)));}
        adaptiveTriggerModeNumber(args){const n=Math.floor(Number(args.NUMBER));const modes=['1. Off','2. Feedback','3. Weapon','4. Vibration','5. Slope Feedback','6. Multiple-Position Feedback','7. Multiple-Position Vibration','8. GameCube Emulation','9. Machine Gun / Automatic','10. Galloping','11. Pistol / Semi-Automatic','12. Rifle / Bow & Arrow','13. Choppy','14. Soft','15. Medium','16. Max','17. Pulse / Tension Guard','18. Rumble Transmission','19. Lock up','20. Calibration (MAY ALTER REAL CALIBRATION!)'];return modes[n-1]||'';}

        async customAdaptiveTriggerEffect(args){if(!await this.requireDualSenseHidForTriggers())return false;const controller=this.getPad(args.CONTROLLER);if(!controller||this.controllerType(controller)!=='PlayStation')return false;const trigger=String(args.TRIGGER||'L').toUpperCase()==='R'?'R':'L';const parseByte=v=>{const n=Number(String(v??'').trim());return Number.isFinite(n)?Math.max(0,Math.min(255,Math.floor(n))):0;};const effect=new Uint8Array(8);effect[0]=parseByte(args.MODE);const values=String(args.PARAMETERS??'').split(/[,\s]+/).filter(Boolean).slice(0,9);for(let i=0;i<Math.min(values.length,7);i++)effect[i+1]=parseByte(values[i]);return this.sendDualSenseTriggerOutput(trigger,effect);}
        async setAdaptiveTriggerMode(args){if(!await this.requireDualSenseHidForTriggers())return false;const controller=this.getPad(args.CONTROLLER);if(!controller||this.controllerType(controller)!=='PlayStation')return false;const trigger=String(args.TRIGGER||'L').toUpperCase()==='R'?'R':'L';const modeName=String(args.MODE||'Off').replace(/^\d+\.\s*/,'');const effect=new Uint8Array(8);switch(modeName){case'Off':effect[0]=0x05;break;case'Feedback':this.setTriggerFeedback(effect,0,6);break;case'Weapon':case'Pistol / Semi-Automatic':this.setTriggerWeapon(effect,2,7,6);break;case'Vibration':this.setTriggerVibration(effect,0,6,40);break;case'Slope Feedback':this.setTriggerMultipleFeedback(effect,[1,2,3,4,5,6,7,7,8,8]);break;case'Multiple-Position Feedback':this.setTriggerMultipleFeedback(effect,[2,2,4,4,6,6,8,8,5,5]);break;case'Multiple-Position Vibration':this.setTriggerMultipleVibration(effect,[2,4,6,8,6,4,2,4,6,8],35);break;case'GameCube Emulation':this.setSimpleFeedback(effect,0x55,0x64);break;case'Machine Gun / Automatic':effect[0]=0x27;effect[1]=(1<<1)|(1<<9);effect[2]=0;effect[3]=(2&7)|((7&7)<<3);effect[4]=18;effect[5]=2;break;case'Galloping':this.setTriggerGalloping(effect,0,9,2,5,2);break;case'Rifle / Bow & Arrow':effect[0]=0x26;effect[1]=0;effect[2]=3;effect[3]=0;effect[4]=0;effect[5]=0;effect[6]=0x3f;effect[7]=10;break;case'Choppy':effect[0]=0x21;effect[1]=2;effect[2]=0x27;effect[3]=0x18;effect[6]=0x26;break;case'Soft':effect[0]=0x05;break;case'Medium':this.setTriggerFeedback(effect,0,4);break;case'Max':this.setTriggerFeedback(effect,0,8);break;case'Pulse / Tension Guard':this.setTriggerWeapon(effect,0,2,6);break;case'Rumble Transmission':this.setTriggerVibration(effect,0,5,30);break;case'Lock up':this.setTriggerFeedback(effect,0,8);break;case'Calibration (MAY ALTER REAL CALIBRATION!)':effect[0]=0xFC;break;default:effect[0]=0x05;break;}return this.sendDualSenseTriggerOutput(trigger,effect);}
        async sendDualSenseTriggerOutput(trigger,effect){
            if(!this.dualSenseConnected())return false;
            try{
                const slot=new Uint8Array(8);
                for(let i=0;i<8;i++)slot[i]=effect&&effect[i]?effect[i]:0;
                if(slot[0]===0)slot[0]=0x05;
                if(String(trigger).toUpperCase()==='R')this.dualSenseOutput.r2Effect=slot;
                else this.dualSenseOutput.l2Effect=slot;
                return this.sendDualSenseOutput();
            }catch(_){return false;}
        }
    }
    Scratch.extensions.register(new ControllerExtension());
})(Scratch);
