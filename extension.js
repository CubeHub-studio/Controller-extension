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
            // Exact Sony hardware model, determined from the HID product ID.
            // 0x0CE6 = regular DualSense, 0x0DF2 = DualSense Edge.
            this.dualSenseHardwareType = 'Unknown';
            this.dualSenseSequence = 0;
            this.dualSenseLightColor = [255, 0, 0];

            // GitHub Pages audio playback state.
            // Web Audio routes an HTMLMediaElement to the DualSense's USB
            // audio endpoint. Bluetooth does not expose the controller speaker
            // as a browser audio output.
            this.githubAudio = null;
            this.githubAudioController = 0;
            this.githubAudioDeviceId = '';
            this.dualSenseAudioDeviceIds = new Map();

            // Persistent output state. Updating one feature must not erase the others.
            this.dualSenseTriggerMode = { L: 'Off', R: 'Off' };

            this.dualSenseOutput = {
                rumbleRight: 0,
                rumbleLeft: 0,
                muteLed: 0,
                playerLeds: 0,
                lightbar: [255, 0, 0],
                // DualSense trigger effect blocks are 10 bytes: mode + 9 parameters.
                r2Effect: new Uint8Array(10),
                l2Effect: new Uint8Array(10)
            };
            this.dualSenseLightBrightness = 255;

            // All DualSense output features share one serialized, throttled queue.
            // Scratch/Gandi can execute command blocks much faster than HID can
            // reasonably be written, so only the newest dirty state is transmitted.
            this.dualSenseOutputDirty = false;
            this.dualSenseOutputSending = false;
            this.dualSenseOutputTimer = null;
            this.dualSenseLastOutputSignature = '';
            this.dualSenseQueuedOutputSignature = '';
            this.dualSenseMinimumOutputInterval = 10;
            this.dualSenseLastOutputTime = 0;

            // Raw DualSense input state. This is used when Chrome exposes the
            // controller through WebHID but does not expose it through the
            // Gamepad API (which can happen when WebHID owns the device).
            this.dualSenseRawButtons = new Array(19).fill(false);
            this.dualSenseRawPreviousButtons = new Array(19).fill(false);
            this.dualSenseRawAxes = [0, 0, 0, 0];
            this.dualSenseTouchX = 0;
            this.dualSenseTouchY = 0;
            this.dualSenseTouchTouched = false;
            this.dualSenseTriggerPressure = { L: 0, R: 0 };
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

            // Release adaptive-trigger effects whenever Gandi/Scratch stops the project.
            // PROJECT_STOP_ALL is the VM event used by the Scratch-compatible runtime.
            try {
                const runtime = Scratch.vm && Scratch.vm.runtime;
                if (runtime && typeof runtime.on === 'function') {
                    runtime.on('PROJECT_STOP_ALL', () => this.resetDualSenseTriggers());
                }
            } catch (_) {}

            // Also release the triggers when the page is being unloaded.
            window.addEventListener('beforeunload', () => {
                this.resetDualSenseTriggers();
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

                // The Web Gamepad API's "standard" mapping does not reliably
                // expose DualSense's physical Create/Share, Options, PS, and
                // touchpad-click buttons. When WebHID has seen a DualSense
                // report, merge those raw HID bits into the Gamepad state so
                // the normal button blocks can read them too.
                if (this.controllerType(pad) === 'PlayStation' && this.dualSenseInputSeen) {
                    // When WebHID owns the DualSense, Chrome's Gamepad API can
                    // expose stale/incomplete button mappings. Use the raw HID
                    // button bitfields for ALL physical buttons instead of only
                    // the extra PS5 buttons.
                    //
                    // DualSense HID layout:
                    // buttons[0]: D-pad + Square/Cross/Circle/Triangle
                    // buttons[1]: L1/R1/L2/R2/Create/Options/L3/R3
                    // buttons[2]: PS/Touchpad/Mute
                    // These are the same masks used by the PlayStation HID
                    // driver and preserve the physical button identity.
                    for (let i = 0; i < 19; i++) {
                        current[i] = !!this.dualSenseRawButtons[i];
                    }
                }

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
            return String(name || '').toLowerCase().replace(/[ _\/-]/g, '');
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
                back: 8, select: 8, share: 8, create: 8, view: 8, backshare: 8,
                start: 9, options: 9, menu: 9, startoptions: 9,
                l3: 10, leftstick: 10,
                r3: 11, rightstick: 11,
                dpadup: 12, up: 12,
                dpaddown: 13, down: 13,
                dpadleft: 14, left: 14,
                dpadright: 15, right: 15,
                home: 16, guide: 16, ps: 16, guideps: 16,
                touchpad: 17, touchpadbutton: 17, mute: 18, micmute: 18
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
                    { opcode: 'triggerPressure', blockType: Scratch.BlockType.REPORTER, text: 'Controller [CONTROLLER] [TRIGGER] trigger pressure', arguments: { CONTROLLER: { type: Scratch.ArgumentType.NUMBER, defaultValue: 1 }, TRIGGER: { type: Scratch.ArgumentType.STRING, menu: 'triggerSides', defaultValue: 'L' } } },
                    { opcode: 'axisValue', blockType: Scratch.BlockType.REPORTER, text: 'controller [CONTROLLER] axis [AXIS]', arguments: { CONTROLLER: { type: Scratch.ArgumentType.NUMBER, defaultValue: 1 }, AXIS: { type: Scratch.ArgumentType.NUMBER, defaultValue: 1 } } },
                    { opcode: 'stickValue', blockType: Scratch.BlockType.REPORTER, text: 'controller [CONTROLLER] [STICK] [DIRECTION]', arguments: { CONTROLLER: { type: Scratch.ArgumentType.NUMBER, defaultValue: 1 }, STICK: { type: Scratch.ArgumentType.STRING, menu: 'sticks', defaultValue: 'Left stick' }, DIRECTION: { type: Scratch.ArgumentType.STRING, menu: 'directions', defaultValue: 'X' } } },
                    '---',
                    { opcode: 'rumble', blockType: Scratch.BlockType.COMMAND, text: 'rumble controller [CONTROLLER] for [DURATION] secs strength [STRENGTH]', arguments: { CONTROLLER: { type: Scratch.ArgumentType.NUMBER, defaultValue: 1 }, DURATION: { type: Scratch.ArgumentType.NUMBER, defaultValue: 0.2 }, STRENGTH: { type: Scratch.ArgumentType.NUMBER, defaultValue: 1 } } },
                    { opcode: 'playGithubAudio', blockType: Scratch.BlockType.COMMAND, text: 'Play (github url) [URL]', arguments: { URL: { type: Scratch.ArgumentType.STRING, defaultValue: 'https://github.com/owner/repo/blob/main/audio.mp3' } } },
                    '---',
                    { opcode: 'searchForNewControllers', blockType: Scratch.BlockType.COMMAND, text: 'Search for new controllers' },
                    { opcode: 'requestHID', blockType: Scratch.BlockType.COMMAND, text: 'Request HID' },
                    { opcode: 'playControllerAudio', blockType: Scratch.BlockType.COMMAND, text: 'Play on controller [CONTROLLER] audio from GitHub Pages [URL]', arguments: { CONTROLLER: { type: Scratch.ArgumentType.NUMBER, defaultValue: 1 }, URL: { type: Scratch.ArgumentType.STRING, defaultValue: 'https://cubehub-studio.github.io/Controller-extension/audio.mp3' } } },
                    { opcode: 'enableDualSenseAudio', blockType: Scratch.BlockType.COMMAND, text: 'Enable DualSense audio output', arguments: {} },
                    { opcode: 'playProjectSoundOnController', blockType: Scratch.BlockType.COMMAND, text: 'Play on controller [CONTROLLER] project sound [SOUND]', arguments: { CONTROLLER: { type: Scratch.ArgumentType.NUMBER, defaultValue: 1 }, SOUND: { type: Scratch.ArgumentType.STRING, defaultValue: '1' } } },
                    { opcode: 'connectDualSense', blockType: Scratch.BlockType.COMMAND, text: 'connect DualSense for lights' },
                    { opcode: 'dualSenseConnected', blockType: Scratch.BlockType.BOOLEAN, text: 'DualSense lights connected?' },
                    { opcode: 'setDualSenseLight', blockType: Scratch.BlockType.COMMAND, text: 'set DualSense light R [RED] G [GREEN] B [BLUE] [TRANSITION]', arguments: { RED: { type: Scratch.ArgumentType.NUMBER, defaultValue: 255 }, GREEN: { type: Scratch.ArgumentType.NUMBER, defaultValue: 0 }, BLUE: { type: Scratch.ArgumentType.NUMBER, defaultValue: 0 }, TRANSITION: { type: Scratch.ArgumentType.STRING, menu: 'lightTransition', defaultValue: 'Instant' } } },
                    { opcode: 'setDualSenseLightBrightness', blockType: Scratch.BlockType.COMMAND, text: 'DualSense light brightness [BRIGHTNESS] [TRANSITION]', arguments: { BRIGHTNESS: { type: Scratch.ArgumentType.NUMBER, defaultValue: 255 }, TRANSITION: { type: Scratch.ArgumentType.STRING, menu: 'lightTransition', defaultValue: 'Instant' } } },
                    { opcode: 'setDualSenseLightOff', blockType: Scratch.BlockType.COMMAND, text: 'turn DualSense light off [TRANSITION]', arguments: { TRANSITION: { type: Scratch.ArgumentType.STRING, menu: 'lightTransition', defaultValue: 'Instant' } } },
                    { opcode: 'setDualSenseMuteLED', blockType: Scratch.BlockType.COMMAND, text: 'set DualSense mute LED [STATE]', arguments: { STATE: { type: Scratch.ArgumentType.STRING, menu: 'muteLEDStates', defaultValue: 'On' } } },
                    { opcode: 'dualSenseMuteLED', blockType: Scratch.BlockType.BOOLEAN, text: 'DualSense mute LED on?' },
                    { opcode: 'customAdaptiveTriggerEffect', blockType: Scratch.BlockType.COMMAND, text: 'Custom adaptive trigger controller [CONTROLLER] trigger [TRIGGER] mode [MODE] parameters [PARAMETERS]', arguments: { CONTROLLER: { type: Scratch.ArgumentType.NUMBER, defaultValue: 1 }, TRIGGER: { type: Scratch.ArgumentType.STRING, menu: 'adaptiveTriggers', defaultValue: 'L' }, MODE: { type: Scratch.ArgumentType.STRING, defaultValue: '0x21' }, PARAMETERS: { type: Scratch.ArgumentType.STRING, defaultValue: '255,255,255,255,255,255,0,0,0,0' } } },
                    { opcode: 'setAdaptiveTriggerMode', blockType: Scratch.BlockType.COMMAND, text: 'set DualSense trigger [TRIGGER] mode to [MODE]', arguments: { CONTROLLER: { type: Scratch.ArgumentType.NUMBER, defaultValue: 1 }, TRIGGER: { type: Scratch.ArgumentType.STRING, menu: 'adaptiveTriggers', defaultValue: 'L' }, MODE: { type: Scratch.ArgumentType.STRING, menu: 'adaptiveTriggerModes', defaultValue: 'Off' } } },
                    { opcode: 'adaptiveTriggerJammed', blockType: Scratch.BlockType.BOOLEAN, text: '[TRIGGER] trigger is jammed?', arguments: { CONTROLLER: { type: Scratch.ArgumentType.NUMBER, defaultValue: 1 }, TRIGGER: { type: Scratch.ArgumentType.STRING, menu: 'adaptiveTriggers', defaultValue: 'L' } } }
                ],
                menus: {
                    physicalButtons: { acceptReporters: true, items: Array.from({ length: 19 }, (_, i) => String(i + 1)) },
                    buttons: { acceptReporters: true, items: ['A','B','X','Y','Cross','Circle','Square','Triangle','LB','RB','LT','RT','L1','R1','L2','R2','Back / Share','Start / Options','L3','R3','DPad Up','DPad Down','DPad Left','DPad Right','Guide / PS','Touchpad','Mute'] },
                    sticks: ['Left stick','Right stick'], directions: ['X','Y'], triggerSides: ['L','R'], muteLEDStates: ['On','Off'], adaptiveTriggers: ['L','R'], lightTransition: ['Fade','Instant'],
                    adaptiveTriggerModes: [
                        'Off','Feedback','Weapon','Vibration','Slope Feedback',
                        'Multiple-Position Feedback','Multiple-Position Vibration','GameCube Emulation',
                        'Machine Gun / Automatic','Galloping','Pistol / Semi-Automatic',
                        'Rifle / Bow & Arrow','Choppy','Soft','Medium','Max',
                        'Pulse / Tension Guard','Rumble Transmission','Lock up'
                    ]
                }
            };
        }

        githubPagesAudioUrl(input) {
            let value = String(input || '').trim();
            if (!value) return '';

            // Accept a normal GitHub file URL:
            // https://github.com/owner/repo/blob/main/path/audio.mp3
            // and play the corresponding GitHub Pages project-site URL:
            // https://owner.github.io/repo/path/audio.mp3
            try {
                const url = new URL(value);
                if (url.hostname === 'github.com') {
                    const parts = url.pathname.split('/').filter(Boolean);
                    if (parts.length >= 5 && parts[2] === 'blob') {
                        const owner = parts[0];
                        const repo = parts[1];
                        const branch = parts[3];
                        const filePath = parts.slice(4).join('/');
                        return 'https://' + owner + '.github.io/' + repo + '/' + filePath;
                    }
                }
            } catch (_) {}

            // Also allow a GitHub Pages URL to be entered directly.
            return value;
        }

        async playGithubAudio(args) {
            const url = this.githubPagesAudioUrl(args.URL);
            if (!url || typeof Audio === 'undefined') return false;

            try {
                if (this.githubAudio) {
                    this.githubAudio.pause();
                    this.githubAudio.currentTime = 0;
                }

                const audio = new Audio();
                audio.src = url;
                audio.preload = 'auto';
                audio.addEventListener('ended', () => {
                    if (this.githubAudio === audio) this.githubAudio = null;
                });

                this.githubAudio = audio;
                await audio.play();
                return true;
            } catch (_) {
                if (this.githubAudio && this.githubAudio.src === url) this.githubAudio = null;
                return false;
            }
        }

        async searchForNewControllers() {
            this.poll();

            // Gamepad API devices are read-only; DualSense HID access requires
            // an explicit user-granted WebHID device. getDevices() only returns
            // devices that were already granted permission, so fall back to
            // requestDevice() when this is the first connection.
            if ('hid' in navigator) {
                try {
                    let devices = await navigator.hid.getDevices();
                    let device = devices.find(d => this.isDualSenseHidDevice(d));

                    if (!device) {
                        const requested = await navigator.hid.requestDevice({
                            filters: [{vendorId: 0x054c}]
                        });
                        device = (requested || []).find(d => this.isDualSenseHidDevice(d)) || null;
                    }

                    if (device) {
                        if (!device.opened) await device.open();
                        this.setDualSenseHidDevice(device);
                    }
                } catch (error) {
                    console.warn('Controller search failed:', error);
                }
            }

            this.poll();
        }

        async findDualSenseAudioOutput(controllerNumber) {
            if (!navigator.mediaDevices || typeof navigator.mediaDevices.enumerateDevices !== 'function') {
                throw new Error('Browser audio output enumeration is unavailable.');
            }

            const n = Math.max(1, Math.floor(Number(controllerNumber) || 1));
            const devices = await navigator.mediaDevices.enumerateDevices();

            // Windows exposes a USB DualSense as an audio output. Chrome does
            // not expose the HID device ID alongside MediaDeviceInfo, so for
            // multiple controllers the controller number maps to the matching
            // audio-output order. This is the most reliable browser-only
            // association available without native Windows APIs.
            const outputs = devices.filter(d => {
                if (d.kind !== 'audiooutput') return false;
                const label = String(d.label || '').toLowerCase();
                return label.includes('wireless controller') ||
                    label.includes('dualsense') ||
                    label.includes('sony interactive entertainment');
            });

            return outputs[n - 1] || null;
        }

        async playControllerAudio(args) {
            const controllerNumber = Math.max(1, Math.floor(Number(args.CONTROLLER) || 1));
            let url = String(args.URL || '').trim();
            if (!url) return;

            // Accept a GitHub Pages URL directly. Also accept a normal GitHub
            // repository/blob URL and convert it to the corresponding raw file
            // URL when possible, so the block is convenient to use.
            if (/^https?:\/\/github\.com\/[^/]+\/[^/]+\/blob\/[^/]+\//i.test(url)) {
                url = url.replace(
                    /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.*)$/i,
                    'https://raw.githubusercontent.com/$1/$2/refs/heads/$3/$4'
                );
            }

            try {
                const output = await this.findDualSenseAudioOutput(controllerNumber);
                if (!output) throw new Error('No matching DualSense audio output was found.');

                if (this.githubAudio) {
                    try {
                        this.githubAudio.pause();
                        this.githubAudio.removeAttribute('src');
                        this.githubAudio.load();
                    } catch (_) {}
                }

                const audio = new Audio();
                audio.preload = 'auto';
                audio.src = url;

                // setSinkId routes the decoded audio directly to the selected
                // Windows audio endpoint instead of the normal browser speaker.
                if (typeof audio.setSinkId !== 'function') {
                    throw new Error('This browser does not support audio output routing (setSinkId).');
                }

                await audio.setSinkId(output.deviceId);
                audio.addEventListener('ended', () => {
                    if (this.githubAudio === audio) {
                        this.githubAudio = null;
                        this.githubAudioDeviceId = '';
                        this.githubAudioController = 0;
                    }
                });

                this.githubAudio = audio;
                this.githubAudioController = controllerNumber;
                this.githubAudioDeviceId = output.deviceId;
                await audio.play();
            } catch (error) {
                // Keep extension blocks non-fatal. The browser console still
                // contains the exact reason if the output is unavailable,
                // permission is missing, or the URL cannot be decoded.
                console.warn('Controller audio playback failed:', error);
            }
        }

        async playProjectSoundOnController(args, util) {
            const controllerNumber = Math.max(1, Math.floor(Number(args && args.CONTROLLER) || 1));
            const target = util && util.target;
            const sounds = target && target.sprite && Array.isArray(target.sprite.sounds)
                ? target.sprite.sounds
                : [];
            if (!sounds.length) return false;

            const requested = String(args && args.SOUND || '');
            let sound = sounds.find(item => String(item.name || '') === requested);
            if (!sound) {
                const index = Number.parseInt(requested, 10);
                if (Number.isInteger(index) && index >= 1 && index <= sounds.length) {
                    sound = sounds[index - 1];
                }
            }
            if (!sound || !sound.asset || !sound.asset.data) {
                console.warn('Project sound is not loaded:', requested);
                return false;
            }

            const format = String(sound.dataFormat || sound.asset.dataFormat || 'wav').toLowerCase();
            const mime = format === 'mp3' ? 'audio/mpeg' :
                format === 'ogg' ? 'audio/ogg' :
                format === 'opus' ? 'audio/ogg; codecs=opus' :
                format === 'm4a' ? 'audio/mp4' :
                'audio/wav';
            const objectUrl = URL.createObjectURL(new Blob([sound.asset.data], {type: mime}));

            try {
                const success = await this.playControllerAudio({
                    CONTROLLER: controllerNumber,
                    URL: objectUrl
                });

                if (success && this.githubAudio) {
                    this.githubAudio.addEventListener('ended', () => {
                        URL.revokeObjectURL(objectUrl);
                    }, {once: true});
                } else {
                    URL.revokeObjectURL(objectUrl);
                }

                return success;
            } catch (error) {
                URL.revokeObjectURL(objectUrl);
                throw error;
            }
        }

        async enableDualSenseAudio() {
            if (!navigator.mediaDevices ||
                typeof navigator.mediaDevices.getUserMedia !== 'function' ||
                typeof navigator.mediaDevices.enumerateDevices !== 'function') {
                console.warn('Browser media-device audio APIs are unavailable.');
                return false;
            }

            let stream = null;
            try {
                // The Web Audio specification permits output-device access to
                // be granted implicitly when the page has permission for a
                // media input in the same physical device group. DualSense USB
                // exposes an audio input as well as its speaker.
                stream = await navigator.mediaDevices.getUserMedia({audio: true});
                const devices = await navigator.mediaDevices.enumerateDevices();

                const outputs = devices.filter(device => {
                    if (device.kind !== 'audiooutput') return false;
                    const label = String(device.label || '').toLowerCase();
                    return label.includes('wireless controller') ||
                        label.includes('dualsense') ||
                        label.includes('sony interactive entertainment');
                });

                if (!outputs.length) {
                    console.warn('No DualSense audio output was exposed by the browser.');
                    return false;
                }

                outputs.forEach((device, index) => {
                    this.dualSenseAudioDeviceIds.set(index + 1, device.deviceId);
                });

                this.githubAudioDeviceId = outputs[0].deviceId;
                this.githubAudioController = 1;
                return true;
            } catch (error) {
                console.warn('Could not enable DualSense audio output:', error);
                return false;
            } finally {
                if (stream) {
                    stream.getTracks().forEach(track => track.stop());
                }
            }
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

        dualSenseHardwareTypeForDevice(device) {
            if (!device || Number(device.vendorId) !== 0x054c) return 'Unknown';

            const pid = Number(device.productId);
            if (pid === 0x0df2) return 'DualSense Edge';
            if (pid === 0x0ce6) return 'DualSense';

            // Keep a name fallback for future/revision PIDs.
            const name = String(device.productName || '').toLowerCase();
            if (name.includes('dualsense edge')) return 'DualSense Edge';
            if (name.includes('dualsense')) return 'DualSense';

            return 'Unknown';
        }

        isDualSenseEdge(device = this.dualSenseHid) {
            return this.dualSenseHardwareTypeForDevice(device) === 'DualSense Edge';
        }

        isDualSenseHidDevice(device) {
            if (!device || Number(device.vendorId) !== 0x054c) return false;

            const type = this.dualSenseHardwareTypeForDevice(device);
            if (type === 'DualSense Edge' || type === 'DualSense') return true;

            return (device.collections || []).some(c =>
                Number(c.usagePage) === 0x0001 && Number(c.usage) === 0x0005
            );
        }

        setDualSenseHidDevice(device) {
            if (!this.isDualSenseHidDevice(device)) return false;

            if (this.dualSenseHid && this.dualSenseInputListener) {
                try {
                    this.dualSenseHid.removeEventListener('inputreport', this.dualSenseInputListener);
                } catch (_) {}
            }

            this.dualSenseHid = device;
            this.dualSenseHardwareType = this.dualSenseHardwareTypeForDevice(device);
            this.dualSenseConnection = this.detectDualSenseTransport(device);
            this.dualSenseInputSeen = false;

            // WebHID inputreport.data excludes the report ID. Listen directly
            // on the HIDDevice and keep the report ID from the event itself.
            this.dualSenseInputListener = event => this.handleDualSenseInputReport(event);
            device.addEventListener('inputreport', this.dualSenseInputListener);

            // Bluetooth DualSense starts with the short report 0x01. Reading
            // feature report 0x05 switches it to the full 0x31 report.
            if (this.dualSenseConnection === 'bluetooth' &&
                typeof device.receiveFeatureReport === 'function') {
                device.receiveFeatureReport(0x05).catch(error => {
                    console.warn('Could not enable the DualSense Bluetooth full input report:', error);
                });
            }

            return true;
        }

        handleDualSenseInputReport(event) {
            if (!event || event.device !== this.dualSenseHid) return;
            const data = event.data;
            if (!data || typeof data.getUint8 !== 'function') return;

            const reportId = Number(event.reportId);
            let buttons0, buttons1, buttons2, axes;
            let triggerL = 0, triggerR = 0;

            // MDN specifies that HIDInputReportEvent.data excludes reportId.
            // USB DualSense report 0x01 is 64 bytes including report ID, so
            // WebHID provides 63 bytes here. Its data begins with X/Y/RX/RY,
            // followed by L2/R2, a sequence byte, and the button bytes.
            if (reportId === 0x01 && data.byteLength >= 63) {
                axes = [
                    (data.getUint8(0) / 127.5) - 1,
                    (data.getUint8(1) / 127.5) - 1,
                    (data.getUint8(2) / 127.5) - 1,
                    (data.getUint8(3) / 127.5) - 1
                ];
                triggerL = data.getUint8(4);
                triggerR = data.getUint8(5);
                buttons0 = data.getUint8(7);
                buttons1 = data.getUint8(8);
                buttons2 = data.getUint8(9);
            } else if (reportId === 0x31 && data.byteLength >= 77) {
                // Bluetooth report 0x31 is 78 bytes including report ID.
                // WebHID removes that ID, leaving the Bluetooth header at
                // data[0], axes at data[1..6], and buttons at data[8..10].
                axes = [
                    (data.getUint8(1) / 127.5) - 1,
                    (data.getUint8(2) / 127.5) - 1,
                    (data.getUint8(3) / 127.5) - 1,
                    (data.getUint8(4) / 127.5) - 1
                ];
                triggerL = data.getUint8(5);
                triggerR = data.getUint8(6);
                buttons0 = data.getUint8(8);
                buttons1 = data.getUint8(9);
                buttons2 = data.getUint8(10);
            } else if (reportId === 0x01 && data.byteLength >= 9) {
                // Bluetooth minimal report 0x01: sticks at data[0..3],
                // buttons at data[4..6], and analog L2/R2 at data[7..8].
                // The PS/mute bits are unavailable until report 0x31 is enabled.
                axes = [
                    (data.getUint8(0) / 127.5) - 1,
                    (data.getUint8(1) / 127.5) - 1,
                    (data.getUint8(2) / 127.5) - 1,
                    (data.getUint8(3) / 127.5) - 1
                ];
                buttons0 = data.getUint8(4);
                buttons1 = data.getUint8(5);
                buttons2 = data.getUint8(6);
                triggerL = data.getUint8(7);
                triggerR = data.getUint8(8);
            } else {
                return;
            }

            const dpad = buttons0 & 0x0F;
            const next = [
                !!(buttons0 & 0x20), !!(buttons0 & 0x40), !!(buttons0 & 0x10), !!(buttons0 & 0x80),
                !!(buttons1 & 0x01), !!(buttons1 & 0x02), !!(buttons1 & 0x04), !!(buttons1 & 0x08),
                !!(buttons1 & 0x10), !!(buttons1 & 0x20), !!(buttons1 & 0x40), !!(buttons1 & 0x80),
                dpad === 0 || dpad === 1 || dpad === 7, dpad === 3 || dpad === 4 || dpad === 5,
                dpad === 5 || dpad === 6 || dpad === 7, dpad === 1 || dpad === 2 || dpad === 3,
                !!(buttons2 & 0x01), !!(buttons2 & 0x02), !!(buttons2 & 0x04)
            ];

            const touchOffset = reportId === 0x31 ? 33 : 32;
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
            this.dualSenseTriggerPressure = { L: triggerL, R: triggerR };
            this.dualSenseInputSeen = true;
            this.previousButtons.set(this.dualSenseSyntheticIndex, this.dualSenseRawPreviousButtons.slice());
            this.currentButtons.set(this.dualSenseSyntheticIndex, this.dualSenseRawButtons.slice());
        }

        controllerCount() { return this.getPads().length; }
        controllerName(args) { const p=this.getPad(args.CONTROLLER); return p ? String(p.id||'') : ''; }
        controllerTypeBlock(args) { const p=this.getPad(args.CONTROLLER); return this.controllerType(p); }
        buttonName(args) {
            const p=this.getPad(args.CONTROLLER); const i=Math.max(0,Math.floor(Number(args.BUTTON)||1)-1); if(!p) return '';
            const names=this.controllerType(p)==='PlayStation' ? ['Cross','Circle','Square','Triangle','L1','R1','L2','R2','Create / Share','Options','L3','R3','DPad Up','DPad Down','DPad Left','DPad Right','Guide / PS','Touchpad','Mute'] : ['A','B','X','Y','LB','RB','LT','RT','View / Back','Menu / Start','LS','RS','DPad Up','DPad Down','DPad Left','DPad Right','Xbox Guide','Extra'];
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
        triggerPressure(args) {
            const p = this.getPad(args.CONTROLLER);
            if (!p) return 0;
            const trigger = String(args.TRIGGER || 'L').toUpperCase() === 'R' ? 'R' : 'L';
            if (this.controllerType(p) === 'PlayStation' && this.dualSenseInputSeen) {
                return this.dualSenseTriggerPressure[trigger];
            }
            const index = trigger === 'R' ? 7 : 6;
            const button = p.buttons && p.buttons[index];
            return Math.round(this.readButtonValue(button) * 255);
        }
        axisValue(args) {
            const p=this.getPad(args.CONTROLLER);
            const n=Math.max(1,Math.floor(Number(args.AXIS)||1))-1;
            if(!p) return 0;
            if(this.controllerType(p)==='PlayStation' && this.dualSenseInputSeen && Number.isFinite(this.dualSenseRawAxes[n])) {
                return this.dualSenseRawAxes[n];
            }
            return Number.isFinite(p.axes[n]) ? p.axes[n] : 0;
        }
        stickValue(args) {
            const p=this.getPad(args.CONTROLLER);
            if(!p) return 0;
            const right=String(args.STICK).toLowerCase().startsWith('right');
            const y=String(args.DIRECTION).toUpperCase()==='Y';
            const axis=(right?2:0)+(y?1:0);
            if(this.controllerType(p)==='PlayStation' && this.dualSenseInputSeen && Number.isFinite(this.dualSenseRawAxes[axis])) {
                return this.dualSenseRawAxes[axis];
            }
            return Number.isFinite(p.axes[axis]) ? p.axes[axis] : 0;
        }

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

            // DualSense main output report validity flags.
            // The known-good DualSense HID reference implementation sends
            // 0xFF for valid_flag0 and 0xF7 for valid_flag1. In particular,
            // bit 0/1 select the controller haptics path, while the trigger
            // effect bytes are consumed from the same main output report.
            // Keep the reference values instead of inventing a separate
            // trigger-only flag combination.
            common[0] = 0x0C | ((this.dualSenseOutput.rumbleRight || this.dualSenseOutput.rumbleLeft) ? 0x03 : 0x00);
            // Keep LED/lightbar controls enabled while explicitly enabling both adaptive-trigger motor channels.
            common[1] = 0xF7;

            common[2] = this.dualSenseOutput.rumbleRight;
            common[3] = this.dualSenseOutput.rumbleLeft;
            common[8] = this.dualSenseOutput.muteLed;
            common[9] = this.dualSenseOutput.muteLed ? 0x00 : 0x10;
            // Overall motor/effect power. Keep trigger attenuation at zero.
            common[37] = 0x00;

            // The DualSense main output report contains an 8-byte adaptive
            // trigger block: mode + 7 parameters. This is the layout used by
            // the WebHID DualSense Explorer reference implementation.
            // USB: R2 common[10..17], L2 common[21..28].
            // Bluetooth: R2 common[12..19], L2 common[23..30].
            const r2Offset = this.dualSenseConnection === 'bluetooth' ? 12 : 10;
            const l2Offset = this.dualSenseConnection === 'bluetooth' ? 23 : 21;
            for (let i = 0; i < 10; i++) {
                common[r2Offset + i] = this.dualSenseOutput.r2Effect[i] || 0;
                common[l2Offset + i] = this.dualSenseOutput.l2Effect[i] || 0;
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

        dualSenseOutputSignature() {
            const o = this.dualSenseOutput;
            return JSON.stringify([
                o.rumbleRight, o.rumbleLeft, o.muteLed, o.playerLeds,
                o.lightbar,
                Array.from(o.r2Effect),
                Array.from(o.l2Effect)
            ]);
        }

        scheduleDualSenseOutput() {
            if (this.dualSenseOutputTimer !== null || this.dualSenseOutputSending) return;
            const wait = Math.max(
                0,
                this.dualSenseMinimumOutputInterval -
                (performance.now() - this.dualSenseLastOutputTime)
            );
            this.dualSenseOutputTimer = setTimeout(() => {
                this.dualSenseOutputTimer = null;
                this.flushDualSenseOutput();
            }, wait);
        }

        async flushDualSenseOutput() {
            if (this.dualSenseOutputSending || !this.dualSenseOutputDirty) return;
            if (!this.dualSenseConnected()) {
                this.dualSenseOutputDirty = false;
                return;
            }

            this.dualSenseOutputSending = true;
            const signature = this.dualSenseOutputSignature();

            try {
                const report = this.buildDualSenseOutputReport();
                await this.dualSenseHid.sendReport(report.reportId, report.data);
                this.dualSenseSequence = (this.dualSenseSequence + 1) & 0x0F;
                this.dualSenseLastOutputTime = performance.now();
                this.dualSenseLastOutputSignature = signature;

                // If another block changed state while sendReport() was waiting,
                // keep the queue dirty and transmit that newer state next.
                this.dualSenseOutputDirty =
                    this.dualSenseOutputSignature() !== this.dualSenseLastOutputSignature;
            } catch (_) {
                // Keep the state dirty so a later call can retry after a transient
                // WebHID failure instead of silently losing the requested effect.
                this.dualSenseOutputDirty = true;
            } finally {
                this.dualSenseOutputSending = false;
                if (this.dualSenseOutputDirty) this.scheduleDualSenseOutput();
            }
        }

        async sendDualSenseOutput(configure) {
            if (!this.dualSenseConnected()) return false;
            try {
                if (typeof configure === 'function') configure(this.dualSenseOutput);

                const signature = this.dualSenseOutputSignature();
                if (
                    signature === this.dualSenseLastOutputSignature ||
                    signature === this.dualSenseQueuedOutputSignature
                ) {
                    return true;
                }

                this.dualSenseQueuedOutputSignature = signature;
                this.dualSenseOutputDirty = true;
                this.scheduleDualSenseOutput();
                return true;
            } catch (_) {
                return false;
            }
        }

        async resetDualSenseTriggers() {
            if (!this.dualSenseConnected()) return false;
            this.dualSenseOutput.r2Effect.fill(0);
            this.dualSenseOutput.l2Effect.fill(0);
            this.dualSenseOutput.r2Effect[0] = 0x05;
            this.dualSenseOutput.l2Effect[0] = 0x05;
            this.dualSenseTriggerMode.R = 'Off';
            this.dualSenseTriggerMode.L = 'Off';

            // Force this safety release through the queue even if the last
            // recorded state already looked neutral.
            this.dualSenseLastOutputSignature = '';
            this.dualSenseQueuedOutputSignature = '';
            this.dualSenseOutputDirty = true;
            this.scheduleDualSenseOutput();
            return true;
        }

        async setDualSenseMuteLED(args) {
            if (!this.dualSenseConnected()) return false;
            const state = String(args && args.STATE || 'On').toLowerCase();
            const enabled = state !== 'off';
            return this.sendDualSenseOutput(output => {
                output.muteLed = enabled ? 1 : 0;
            });
        }

        dualSenseMuteLED() {
            return !!(this.dualSenseConnected() && this.dualSenseOutput.muteLed);
        }

        async setDualSenseLightColor(r,g,b,transition){if(!this.dualSenseConnected())return false;r=this.clampByte(r);g=this.clampByte(g);b=this.clampByte(b);const start=this.dualSenseLightColor.slice(),steps=String(transition||'Instant')==='Fade'?10:1;for(let i=1;i<=steps;i++){const t=i/steps,cr=Math.round(start[0]+(r-start[0])*t),cg=Math.round(start[1]+(g-start[1])*t),cb=Math.round(start[2]+(b-start[2])*t);if(!await this.sendDualSenseOutput(state=>{state.lightbar=[cr,cg,cb];}))return false;if(steps>1&&i<steps)await new Promise(resolve=>setTimeout(resolve,30));}this.dualSenseLightColor=[r,g,b];return true;}
        async setDualSenseLight(args){const r=this.clampByte(args.RED),g=this.clampByte(args.GREEN),b=this.clampByte(args.BLUE);this.dualSenseLightBrightness=255;return this.setDualSenseLightColor(r,g,b,args.TRANSITION);}
        async setDualSenseLightBrightness(args){if(!this.dualSenseConnected())return false;const brightness=Math.max(0,Math.min(255,Math.floor(Number(args.BRIGHTNESS)||0)));this.dualSenseLightBrightness=brightness;const base=this.dualSenseLightColor.slice();return this.setDualSenseLightColor(Math.round(base[0]*brightness/255),Math.round(base[1]*brightness/255),Math.round(base[2]*brightness/255),args.TRANSITION);}
        async setDualSenseLightOff(args){if(!this.dualSenseConnected())return false;const mode=String(args&&args.TRANSITION||'Instant'),start=this.dualSenseLightColor.slice(),steps=mode==='Fade'?10:1;for(let i=1;i<=steps;i++){const t=i/steps;if(!await this.sendDualSenseOutput(state=>{state.lightbar=[Math.round(start[0]*(1-t)),Math.round(start[1]*(1-t)),Math.round(start[2]*(1-t))];}))return false;if(steps>1&&i<steps)await new Promise(resolve=>setTimeout(resolve,30));}return true;}
        async sendDualSenseRumble(strength,duration){if(!this.dualSenseConnected())return false;const motor=Math.round(Math.max(0,Math.min(1,Number(strength)||0))*255);return this.sendDualSenseOutput(state=>{state.rumbleRight=motor;state.rumbleLeft=motor;});}
        async requireDualSenseHidForTriggers(){if(!('hid'in navigator))return false;if(this.dualSenseConnected())return true;try{const devices=await navigator.hid.getDevices();let device=devices.find(d=>this.isDualSenseHidDevice(d));if(!device){const requested=await navigator.hid.requestDevice({filters:[{vendorId:0x054c}]});device=requested&&requested[0];}if(!device||!this.isDualSenseHidDevice(device))return false;if(!device.opened)await device.open();this.setDualSenseHidDevice(device);return true;}catch(_){return false;}}

        // DualSense adaptive-trigger effects use an 8-byte block:
        // [mode, parameter1..parameter7]. These values follow the
        // WebHID DualSense Explorer reference implementation.
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
                'Lock up': 0x21,
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
                case 'Lock up':
                    if (this.isDualSenseEdge()) {
                        // DualSense Edge has a real mechanical L2/R2 stop.
                        // The physical stop, not HID adaptive-trigger output,
                        // limits trigger travel. Sony documents that the
                        // short/medium stop positions disable trigger effects.
                        effect[0] = 0x05;
                    } else {
                        // Regular DualSense has no mechanical trigger stop.
                        // Use the strongest continuous resistance available,
                        // starting immediately, for the hardest software wall.
                        this.setTriggerFeedback(effect, 0, 8);
                    }
                    break;
                case 'Calibration':
                    effect[0] = 0x05;
                    break;
                default:
                    effect[0] = 0x05;
                    break;
            }
            this.dualSenseTriggerMode[trigger] = modeName;
            return this.sendDualSenseTriggerOutput(trigger, effect);
        }


        async customAdaptiveTriggerEffect(args) {
            if (!await this.requireDualSenseHidForTriggers()) return false;
            const controller = this.getPad(args.CONTROLLER);
            if (!controller || this.controllerType(controller) !== 'PlayStation') return false;

            const trigger = String(args.TRIGGER || 'L').toUpperCase() === 'R' ? 'R' : 'L';
            const parseByte = value => {
                const n = Number(String(value ?? '').trim());
                return Number.isFinite(n) ? Math.max(0, Math.min(255, Math.floor(n))) : 0;
            };

            const effect = new Uint8Array(8);
            effect[0] = parseByte(args.MODE);
            const values = String(args.PARAMETERS ?? '')
                .split(/[,\\s]+/)
                .filter(Boolean)
                .slice(0, 7);

            for (let i = 0; i < values.length; i++) {
                effect[i + 1] = parseByte(values[i]);
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