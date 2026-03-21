(function () {
    'use strict';

    const BT_VERSION = '5.0';

    if (window.__bagTool) return;

    class BagTool {
        constructor() {
            this.token = null;
            this.tokenTimestamp = null;
            this.state = 'READY'; // READY | VALIDATING | AWAITING_LOCATION | LINKING
            this.currentBag = null;
            this.scanBuffer = '';
            this.scanTimeout = null;
            this.lastKeystroke = 0;
            this.history = [];
            this.el = {};

            this.init();
        }

        init() {
            this.patchXHR();
            this.patchFetch();
            this.injectStyles();
            this.buildUI();
            this.bindScanner();
            this.log('Initialized - scan a bag to begin');
            this.log('Active element: ' + (document.activeElement?.tagName || 'none') + '#' + (document.activeElement?.id || 'none'));
            this.log('Document ready state: ' + document.readyState);
                        // Dump all window properties that look scanner-related
            Object.getOwnPropertyNames(window).forEach(k => {
                const lower = k.toLowerCase();
                if (lower.includes('scan') || lower.includes('barcode') || lower.includes('wedge') || lower.includes('zebra') || lower.includes('bridge') || lower.includes('native') || lower.includes('android')) {
                    this.log('Window prop: ' + k + ' = ' + typeof window[k]);
                }
            });
        }

        // ==========================================
        //  TOKEN INTERCEPTION
        // ==========================================

        patchXHR() {
            const self = this;
            const orig = XMLHttpRequest.prototype.setRequestHeader;
            XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
                if (name.toLowerCase() === 'x-amz-access-token') {
                    self.token = value;
                    self.tokenTimestamp = Date.now();
                    self.updateTokenDot();
                }
                return orig.apply(this, arguments);
            };
        }

        patchFetch() {
            const self = this;
            const orig = window.fetch;
            window.fetch = function (url, options) {
                if (options && options.headers) {
                    const h = options.headers;
                    if (h instanceof Headers) {
                        const t = h.get('x-amz-access-token');
                        if (t) { self.token = t; self.tokenTimestamp = Date.now(); self.updateTokenDot(); }
                    } else if (typeof h === 'object' && !Array.isArray(h)) {
                        Object.keys(h).forEach(k => {
                            if (k.toLowerCase() === 'x-amz-access-token') {
                                self.token = h[k]; self.tokenTimestamp = Date.now(); self.updateTokenDot();
                            }
                        });
                    }
                }
                return orig.apply(this, arguments);
            };
        }

        // ==========================================
        //  SCANNER INPUT DETECTION
        // ==========================================

            bindScanner() {
            const self = this;

            // ---- 1. Hook input value setter (catches direct .value = 'xxx') ----
            const inputDesc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
            const origSet = inputDesc.set;
            Object.defineProperty(HTMLInputElement.prototype, 'value', {
                get: inputDesc.get,
                set: function(val) {
                    if (val && val.length > 3) {
                        self.log('INPUT.value SET: "' + val + '" on #' + (this.id || this.name || this.tagName));
                    }
                    return origSet.call(this, val);
                },
                configurable: true
            });

            // Same for textarea
            const taDesc = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
            if (taDesc) {
                const origTASet = taDesc.set;
                Object.defineProperty(HTMLTextAreaElement.prototype, 'value', {
                    get: taDesc.get,
                    set: function(val) {
                        if (val && val.length > 3) {
                            self.log('TEXTAREA.value SET: "' + val + '"');
                        }
                        return origTASet.call(this, val);
                    },
                    configurable: true
                });
            }

            // ---- 2. Listen for paste events ----
            document.addEventListener('paste', function(e) {
                const text = (e.clipboardData || window.clipboardData)?.getData('text');
                self.log('PASTE event: "' + text + '"');
            }, true);

            // ---- 3. Listen for composition events (IME) ----
            ['compositionstart', 'compositionupdate', 'compositionend'].forEach(evt => {
                document.addEventListener(evt, function(e) {
                    self.log('COMPOSITION: ' + e.type + ' data="' + e.data + '"');
                }, true);
            });

            // ---- 4. Listen for custom events ----
            ['scan', 'scanner', 'barcode', 'datawedge', 'scanresult'].forEach(evt => {
                document.addEventListener(evt, function(e) {
                    self.log('CUSTOM EVENT: ' + evt + ' detail=' + JSON.stringify(e.detail));
                }, true);
                window.addEventListener(evt, function(e) {
                    self.log('WINDOW CUSTOM: ' + evt + ' detail=' + JSON.stringify(e.detail));
                }, true);
            });

            // ---- 5. Check for Android bridge objects ----
            const bridgeNames = [
                'Android', 'android', 'scanner', 'Scanner',
                'DataWedge', 'datawedge', 'ZebraScanner',
                'ScannerPlugin', 'scannerPlugin',
                'NativeInterface', 'nativeInterface',
                'AppInterface', 'appInterface',
                'JSInterface', 'jsInterface',
                'webkit', 'BarcodeScanner',
                'DolphinScanner', 'dolphinScanner'
            ];
            bridgeNames.forEach(name => {
                if (window[name] !== undefined) {
                    self.log('BRIDGE FOUND: window.' + name + ' = ' + typeof window[name]);
                    try {
                        const methods = Object.getOwnPropertyNames(window[name]);
                        self.log('  methods: ' + methods.join(', '));
                    } catch(e) {
                        self.log('  (could not enumerate)');
                    }
                }
            });

            // ---- 6. Monitor window for new properties ----
            const knownKeys = new Set(Object.keys(window));
            setInterval(() => {
                Object.keys(window).forEach(k => {
                    if (!knownKeys.has(k)) {
                        knownKeys.add(k);
                        self.log('NEW window.' + k + ' = ' + typeof window[k]);
                    }
                });
            }, 2000);

            // ---- 7. Monkey-patch postMessage ----
            const origPostMessage = window.postMessage;
            window.postMessage = function(msg, origin) {
                if (typeof msg === 'string' && msg.length > 3) {
                    self.log('postMessage: "' + msg.substring(0, 100) + '"');
                } else if (typeof msg === 'object') {
                    self.log('postMessage obj: ' + JSON.stringify(msg).substring(0, 200));
                }
                return origPostMessage.apply(this, arguments);
            };

            // ---- 8. Monitor message events ----
            window.addEventListener('message', function(e) {
                const d = typeof e.data === 'string' ? e.data.substring(0, 200) : JSON.stringify(e.data).substring(0, 200);
                self.log('MESSAGE event: ' + d);
            }, true);

            // ---- 9. Hook addEventListener itself to see what Dolphin listens for ----
            const origAddEvent = EventTarget.prototype.addEventListener;
            const loggedTypes = new Set();
            EventTarget.prototype.addEventListener = function(type, fn, opts) {
                if (!loggedTypes.has(type) && type !== 'error' && type !== 'load') {
                    loggedTypes.add(type);
                    self.log('addEventListener: "' + type + '" on ' + (this.id || this.tagName || this.constructor?.name || 'unknown'));
                }
                return origAddEvent.call(this, type, fn, opts);
            };

            // ---- 10. Still listen for keyboard just in case ----
            document.addEventListener('keydown', function(e) {
                self.log('KEYDOWN: key=' + e.key + ' code=' + e.keyCode);
            }, true);

            this.log('All diagnostic hooks attached');
            this.log('Inputs found: ' + document.querySelectorAll('input').length);
            this.log('Active element: ' + (document.activeElement?.tagName || 'none') + '#' + (document.activeElement?.id || ''));
        }
        // ==========================================
        //  SCAN PROCESSING
        // ==========================================

        async processScan(value) {
            value = value.trim();
            this.log('Scanned: ' + value);

            if (this.state === 'READY' || this.state === 'VALIDATING') {
                // Treat as bag scan
                await this.handleBagScan(value);
            } else if (this.state === 'AWAITING_LOCATION') {
                // Treat as location scan
                await this.handleLocationScan(value);
            }
        }

        async handleBagScan(bagId) {
            this.state = 'VALIDATING';
            this.currentBag = bagId;
            this.setStatus('VALIDATING', bagId, 'pending');

            try {
                const res = await fetch('https://dolphin.amazon.com/nss/open/validateBag', {
                    method: 'POST',
                    headers: {
                        'Accept': 'application/json, text/plain, */*',
                        'Content-Type': 'application/json;charset=utf-8'
                    },
                    body: JSON.stringify({
                        bagScannableId: bagId,
                        scope: 'AMZL'
                    })
                });

                if (!res.ok) throw new Error('HTTP ' + res.status);
                const data = await res.json();

                if (data.responseCode === 'SUCCESS') {
                    const existing = data.existingDestinationLabel;
                    this.state = 'AWAITING_LOCATION';
                    if (existing) {
                        this.setStatus('SCAN LOCATION', bagId + ' -> currently: ' + existing, 'ready');
                    } else {
                        this.setStatus('SCAN LOCATION', bagId + ' (no current destination)', 'ready');
                    }
                    this.log('Bag valid: ' + bagId + (existing ? ' at ' + existing : ' unlinked'));
                } else {
                    this.state = 'READY';
                    this.setStatus('BAG ERROR', data.responseCode || 'Unknown error', 'error');
                    this.log('Bag error: ' + (data.responseCode || 'unknown'));
                }
            } catch (err) {
                this.state = 'READY';
                this.setStatus('ERROR', err.message, 'error');
                this.log('validateBag failed: ' + err.message);
            }
        }

        async handleLocationScan(locationId) {
            if (!this.currentBag) {
                this.state = 'READY';
                this.setStatus('ERROR', 'No bag scanned', 'error');
                return;
            }

            if (!this.token) {
                this.setStatus('NO TOKEN', 'Use original app once first', 'error');
                this.log('No token for linking');
                return;
            }

            this.state = 'LINKING';
            this.setStatus('LINKING', this.currentBag + ' -> ' + locationId, 'pending');

            try {
                const res = await fetch('https://dolphin.amazon.com/nss/open/bag', {
                    method: 'POST',
                    headers: {
                        'Accept': 'application/json, text/plain, */*',
                        'Content-Type': 'application/json;charset=utf-8',
                        'x-amz-access-token': this.token
                    },
                    body: JSON.stringify({
                        bagScannableId: this.currentBag,
                        destinationScannableId: locationId,
                        scope: 'AMZL'
                    })
                });

                if (!res.ok) throw new Error('HTTP ' + res.status);
                const data = await res.json();

                if (data.responseCode === 'SUCCESS') {
                    this.setStatus('SUCCESS', data.bagLabel + ' -> ' + data.destinationLabel, 'success');
                    this.addHistory(data.bagLabel, data.destinationLabel, false);
                    this.log('Linked: ' + data.bagLabel + ' -> ' + data.destinationLabel);
                } else {
                    this.setStatus('LINK ERROR', data.responseCode || 'Unknown', 'error');
                    this.addHistory(this.currentBag, 'ERROR', true);
                    this.log('Link error: ' + (data.responseCode || 'unknown'));
                }
            } catch (err) {
                this.setStatus('ERROR', err.message, 'error');
                this.addHistory(this.currentBag, 'ERROR', true);
                this.log('open/bag failed: ' + err.message);
            }

            // Reset for next bag after brief display
            const bag = this.currentBag;
            this.currentBag = null;
            setTimeout(() => {
                if (this.state === 'LINKING' || this.state === 'SUCCESS') {
                    this.state = 'READY';
                    this.setStatus('SCAN BAG', 'Ready', 'idle');
                }
            }, 1500);
            this.state = 'READY';
        }

        // ==========================================
        //  STYLES
        // ==========================================

        injectStyles() {
            const style = document.createElement('style');
            style.id = 'bt-styles';
            style.textContent = `
                #bt-bar {
                    position: fixed;
                    top: 0; left: 0; right: 0;
                    z-index: 2147483647;
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                    transition: background 0.2s;
                    user-select: none;
                    -webkit-tap-highlight-color: transparent;
                }
                #bt-bar.bt-idle { background: #232f3e; }
                #bt-bar.bt-ready { background: #0d47a1; }
                #bt-bar.bt-pending { background: #e65100; }
                #bt-bar.bt-success { background: #1b5e20; }
                #bt-bar.bt-error { background: #b71c1c; }

                #bt-main {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    padding: 8px 12px;
                }
                #bt-state {
                    font-size: 11px;
                    font-weight: 800;
                    color: rgba(255,255,255,0.9);
                    letter-spacing: 1px;
                    text-transform: uppercase;
                    white-space: nowrap;
                }
                #bt-msg {
                    font-size: 12px;
                    color: rgba(255,255,255,0.75);
                    text-align: right;
                    flex: 1;
                    margin-left: 12px;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                }
                #bt-token-dot {
                    width: 6px; height: 6px;
                    border-radius: 50%;
                    background: #ff4444;
                    margin-left: 8px;
                    flex-shrink: 0;
                    transition: background 0.3s;
                }
                #bt-token-dot.bt-live { background: #00e676; }

                #bt-detail {
                    display: none;
                    padding: 0 12px 8px;
                    font-size: 28px;
                    font-weight: 900;
                    color: #fff;
                    text-align: center;
                    letter-spacing: 1px;
                }
                #bt-detail.bt-show { display: block; }

                #bt-history-toggle {
                    display: block;
                    width: 100%;
                    background: none;
                    border: none;
                    border-top: 1px solid rgba(255,255,255,0.1);
                    color: rgba(255,255,255,0.3);
                    font-size: 10px;
                    padding: 4px;
                    cursor: pointer;
                    text-align: center;
                }
                #bt-history-panel {
                    display: none;
                    max-height: 150px;
                    overflow-y: auto;
                    padding: 4px 12px 8px;
                }
                #bt-history-panel.bt-show { display: block; }
                .bt-hist-row {
                    display: flex;
                    justify-content: space-between;
                    padding: 3px 0;
                    font-size: 11px;
                    border-bottom: 1px solid rgba(255,255,255,0.05);
                }
                .bt-hist-bag { color: rgba(255,255,255,0.5); font-family: monospace; }
                .bt-hist-dest { color: #69f0ae; font-weight: 700; }
                .bt-hist-dest.bt-err { color: #ff8a80; }

                #bt-debug {
                    display: none;
                    padding: 4px 12px 8px;
                    font-family: 'Courier New', monospace;
                    font-size: 9px;
                    color: #0f0;
                    background: rgba(0,0,0,0.3);
                    max-height: 100px;
                    overflow-y: auto;
                    white-space: pre-wrap;
                    word-break: break-all;
                }
                #bt-debug.bt-show { display: block; }

                .bt-ver {
                    font-size: 8px;
                    color: rgba(255,255,255,0.15);
                    text-align: center;
                    padding: 2px;
                }
            `;
            document.head.appendChild(style);
        }

        // ==========================================
        //  BUILD UI
        // ==========================================

        buildUI() {
            const bar = document.createElement('div');
            bar.id = 'bt-bar';
            bar.className = 'bt-idle';
            bar.innerHTML = `
                <div id="bt-main">
                    <span id="bt-state">SCAN BAG</span>
                    <span id="bt-msg">Ready</span>
                    <div id="bt-token-dot"></div>
                </div>
                <div id="bt-detail"></div>
                <button id="bt-history-toggle">history</button>
                <div id="bt-history-panel"></div>
                <div id="bt-debug"></div>
                <button id="bt-copy" style="
                    display:block; width:100%;
                    background:none; border:none;
                    border-top:1px solid rgba(255,255,255,0.1);
                    color:rgba(255,255,255,0.3);
                    font-size:10px; padding:4px;
                    cursor:pointer; text-align:center;
                ">COPY LOG</button>
                <div class="bt-ver">v${BT_VERSION}</div>
            `;
            document.body.appendChild(bar);

            this.el.bar = bar;
            this.el.state = document.getElementById('bt-state');
            this.el.msg = document.getElementById('bt-msg');
            this.el.detail = document.getElementById('bt-detail');
            this.el.tokenDot = document.getElementById('bt-token-dot');
            this.el.historyToggle = document.getElementById('bt-history-toggle');
            this.el.historyPanel = document.getElementById('bt-history-panel');
            this.el.debug = document.getElementById('bt-debug');
            this.el.copyBtn = document.getElementById('bt-copy');
            this.el.copyBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.copyHistory();
            });

            // Toggle history
            this.el.historyToggle.addEventListener('click', (e) => {
                e.stopPropagation();
                this.el.historyPanel.classList.toggle('bt-show');
            });

            // Toggle debug on long press
            let pressTimer;
            this.el.bar.addEventListener('touchstart', () => {
                pressTimer = setTimeout(() => {
                    this.el.debug.classList.toggle('bt-show');
                }, 800);
            }, { passive: true });
            this.el.bar.addEventListener('touchend', () => clearTimeout(pressTimer), { passive: true });
        }

        // ==========================================
        //  UI UPDATES
        // ==========================================

        setStatus(stateText, message, type) {
            this.el.state.textContent = stateText;
            this.el.msg.textContent = message;
            this.el.bar.className = 'bt-' + type;

            // Show large detail for SUCCESS and certain states
            if (type === 'success' || type === 'ready') {
                const detail = message.includes('->') ? message.split('->').pop().trim() : '';
                if (detail) {
                    this.el.detail.textContent = detail;
                    this.el.detail.classList.add('bt-show');
                } else {
                    this.el.detail.classList.remove('bt-show');
                }
            } else {
                this.el.detail.classList.remove('bt-show');
            }
        }

        updateTokenDot() {
            if (this.el.tokenDot) {
                this.el.tokenDot.classList.toggle('bt-live', !!this.token);
            }
        }

        addHistory(bag, dest, isError) {
            this.history.unshift({ bag, dest, isError });
            if (this.history.length > 50) this.history.pop();
            this.el.historyPanel.innerHTML = this.history.map(h =>
                `<div class="bt-hist-row">
                    <span class="bt-hist-bag">${h.bag}</span>
                    <span class="bt-hist-dest${h.isError ? ' bt-err' : ''}">${h.dest}</span>
                </div>`
            ).join('');
        }

                copyHistory() {
            const lines = this.history.map(h =>
                h.bag + ' -> ' + h.dest + (h.isError ? ' [ERROR]' : '')
            ).join('\n');

            const debugLines = this.el.debug ? this.el.debug.textContent : '';
            const output = '=== BAG HISTORY ===\n' + (lines || '(empty)') + '\n\n=== DEBUG LOG ===\n' + debugLines;

            navigator.clipboard.writeText(output).then(() => {
                this.el.copyBtn.textContent = 'COPIED';
                setTimeout(() => { this.el.copyBtn.textContent = 'COPY LOG'; }, 1500);
            }).catch(() => {
                const ta = document.createElement('textarea');
                ta.value = output;
                document.body.appendChild(ta);
                ta.select();
                document.execCommand('copy');
                ta.remove();
                this.el.copyBtn.textContent = 'COPIED';
                setTimeout(() => { this.el.copyBtn.textContent = 'COPY LOG'; }, 1500);
            });
            this.log('Copied to clipboard');
        }
        log(msg) {
            const ts = new Date().toLocaleTimeString();
            const entry = '[' + ts + '] ' + msg;
            console.log('[BT] ' + entry);
            if (this.el.debug) {
                this.el.debug.textContent = entry + '\n' + this.el.debug.textContent;
                const lines = this.el.debug.textContent.split('\n');
                if (lines.length > 30) {
                    this.el.debug.textContent = lines.slice(0, 30).join('\n');
                }
            }
        }
    }

    window.__bagTool = new BagTool();
})();