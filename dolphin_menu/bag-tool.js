(function () {
    'use strict';

    const BT_VERSION = '2.0';

    class BagTool {
        constructor(launcher) {
            this.launcher = launcher;
            this.state = 'READY';
            this.currentBag = null;
            this.history = [];
            this.el = {};
            this.intercepting = false;
            this._onKeydown = null;
            this._unsubToken = null;
            this._destroyed = false;

            this.injectStyles();
            this.buildUI();
            this.bindScanner();
            this.updateTokenDot();

            this._unsubToken = this.launcher.onTokenChange(() => {
                if (!this._destroyed) this.updateTokenDot();
            });

            this.log('Initialized \u2014 passthrough mode, use Dolphin then tap ON');
            this.setStatus('PASSTHROUGH', 'Use Dolphin to get token, then tap ON', 'pending');
        }

        get token() {
            return this.launcher ? this.launcher.token : null;
        }

        get tokenTimestamp() {
            return this.launcher ? this.launcher.tokenTimestamp : null;
        }

        shouldBlockFocus() {
            return false;
        }

        // ==========================================
        //  DESTROY
        // ==========================================

        destroy() {
            this._destroyed = true;

            if (this._onKeydown) {
                document.removeEventListener('keydown', this._onKeydown, true);
                this._onKeydown = null;
            }
            if (this._unsubToken) {
                this._unsubToken();
                this._unsubToken = null;
            }

            // Remove DOM
            if (this.el.bar) this.el.bar.remove();
            // Fallback
            const orphan = document.getElementById('bt-bar');
            if (orphan) orphan.remove();
            const style = document.getElementById('bt-styles');
            if (style) style.remove();

            this.el = {};
            this.launcher = null;
            console.log('[BT] Destroyed');
        }

        // ==========================================
        //  SCANNER
        // ==========================================

        bindScanner() {
            this._onKeydown = (e) => {
                if (this._destroyed) return;
                if (e.key === 'Enter' || e.keyCode === 13) {
                    if (!this.intercepting) return;

                    const active = document.activeElement;
                    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) {
                        const val = active.value.trim();
                        this.log('Enter on ' + active.tagName + '#' + (active.id || 'unknown') + ' value="' + val + '"');
                        if (val.length > 3) {
                            e.preventDefault();
                            e.stopImmediatePropagation();
                            active.value = '';
                            this.processScan(val);
                        }
                    }
                }
            };
            document.addEventListener('keydown', this._onKeydown, true);
            this.log('Scanner listener attached');
        }

        // ==========================================
        //  SCAN PROCESSING
        // ==========================================

        async processScan(value) {
            if (this._destroyed) return;
            value = value.trim();
            this.log('Scanned: ' + value);

            if (this.state === 'READY' || this.state === 'VALIDATING') {
                await this.handleBagScan(value);
            } else if (this.state === 'AWAITING_LOCATION') {
                await this.handleLocationScan(value);
            }
        }

        async handleBagScan(bagId) {
            if (this._destroyed) return;
            this.state = 'VALIDATING';
            this.currentBag = bagId;
            this.setStatus('VALIDATING', bagId, 'pending');

            if (!this.token) {
                this.setStatus('NO TOKEN', 'Use original app once first', 'error');
                this.state = 'READY';
                this.log('No token for validateBag');
                return;
            }

            try {
                const res = await fetch('https://dolphin.amazon.com/nss/open/validateBag', {
                    method: 'POST',
                    headers: {
                        'Accept': 'application/json, text/plain, */*',
                        'Content-Type': 'application/json;charset=utf-8',
                        'x-amz-access-token': this.token
                    },
                    body: JSON.stringify({
                        bagScannableId: bagId,
                        scope: 'AMZL'
                    })
                });

                if (this._destroyed) return;
                if (!res.ok) {
                    const body = await res.text();
                    throw new Error('HTTP ' + res.status + ' | ' + body.substring(0, 200));
                }
                const data = await res.json();

                if (this._destroyed) return;
                if (data.responseCode === 'SUCCESS') {
                    const existing = data.existingDestinationLabel;
                    this.state = 'AWAITING_LOCATION';
                    if (existing) {
                        this.setStatus('SCAN LOCATION', bagId + ' \u2192 currently: ' + existing, 'ready');
                    } else {
                        this.setStatus('SCAN LOCATION', bagId + ' (no current destination)', 'ready');
                    }
                    this.playSound('scan');
                    this.log('Bag valid: ' + bagId + (existing ? ' at ' + existing : ' unlinked'));
                } else {
                    this.state = 'READY';
                    this.setStatus('BAG ERROR', data.responseCode || 'Unknown error', 'error');
                    this.playSound('error');
                }
            } catch (err) {
                if (this._destroyed) return;
                this.state = 'READY';
                this.setStatus('ERROR', err.message, 'error');
                this.playSound('error');
                this.log('validateBag failed: ' + err.message);
            }
        }

        async handleLocationScan(locationId) {
            if (this._destroyed) return;
            if (!this.currentBag) {
                this.state = 'READY';
                this.setStatus('ERROR', 'No bag scanned', 'error');
                this.playSound('error');
                return;
            }
            if (!this.token) {
                this.setStatus('NO TOKEN', 'Use original app once first', 'error');
                this.playSound('error');
                return;
            }

            const bag = this.currentBag;
            this.currentBag = null;
            this.state = 'READY';
            this.setStatus('LINKING...', bag + ' \u2192 ' + locationId, 'pending');
            this.playSound('scan');
            this.linkBagAsync(bag, locationId);
        }

        linkBagAsync(bag, locationId) {
            fetch('https://dolphin.amazon.com/nss/open/bag', {
                method: 'POST',
                headers: {
                    'Accept': 'application/json, text/plain, */*',
                    'Content-Type': 'application/json;charset=utf-8',
                    'x-amz-access-token': this.token
                },
                body: JSON.stringify({
                    bagScannableId: bag,
                    destinationScannableId: locationId,
                    scope: 'AMZL'
                })
            }).then(async (res) => {
                if (this._destroyed) return;
                if (!res.ok) {
                    const body = await res.text();
                    throw new Error('HTTP ' + res.status + ' | ' + body.substring(0, 200));
                }
                return res.json();
            }).then((data) => {
                if (this._destroyed || !data) return;
                if (data.responseCode === 'SUCCESS') {
                    this.addHistory(data.bagLabel, data.destinationLabel, false);
                    this.playSound('success');
                    this.log('Linked: ' + data.bagLabel + ' \u2192 ' + data.destinationLabel);
                    if (this.state === 'READY' && !this.currentBag) {
                        this.setStatus('SCAN BAG', 'Last: ' + data.bagLabel + ' \u2192 ' + data.destinationLabel, 'success');
                        setTimeout(() => {
                            if (!this._destroyed && this.state === 'READY' && !this.currentBag) {
                                this.setStatus('SCAN BAG', 'Ready', 'idle');
                            }
                        }, 2000);
                    }
                } else {
                    this.addHistory(bag, data.responseCode || 'ERROR', true);
                    this.playSound('error');
                    if (this.state === 'READY' && !this.currentBag) {
                        this.setStatus('LINK ERROR', data.responseCode || 'Unknown', 'error');
                    }
                }
            }).catch((err) => {
                if (this._destroyed) return;
                this.addHistory(bag, 'ERR', true);
                this.playSound('error');
                this.log('open/bag failed: ' + err.message);
                if (this.state === 'READY' && !this.currentBag) {
                    this.setStatus('ERROR', err.message, 'error');
                }
            });
        }

        // ==========================================
        //  STYLES
        // ==========================================

        injectStyles() {
            if (document.getElementById('bt-styles')) return;
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
                    padding: 8px 12px;
                }
                #bt-back {
                    background: none;
                    border: none;
                    color: rgba(255,255,255,0.7);
                    font-size: 18px;
                    cursor: pointer;
                    padding: 4px 10px 4px 0;
                    touch-action: manipulation;
                    -webkit-tap-highlight-color: transparent;
                    flex-shrink: 0;
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
                    <button id="bt-back" style="font-size:14px;margin-right:6px;">\u25C0 MENU</button>
                    <span id="bt-state">SCAN BAG</span>
                    <span id="bt-msg">Passthrough</span>
                    <button id="bt-mode" style="
                        margin-left:8px;
                        padding:3px 8px;
                        border:none;
                        border-radius:4px;
                        font-size:10px;
                        font-weight:800;
                        background:#ff4444;
                        color:#fff;
                        cursor:pointer;
                        flex-shrink:0;
                    ">OFF</button>
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
            this.el.modeBtn = document.getElementById('bt-mode');
            this.el.copyBtn = document.getElementById('bt-copy');
            this.el.backBtn = document.getElementById('bt-back');

            this.el.backBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (this.launcher) this.launcher.goBack();
            });

            this.el.modeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.toggleMode();
            });

            this.el.copyBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.copyHistory();
            });

            this.el.historyToggle.addEventListener('click', (e) => {
                e.stopPropagation();
                this.el.historyPanel.classList.toggle('bt-show');
            });

            let pressTimer;
            this.el.bar.addEventListener('touchstart', () => {
                pressTimer = setTimeout(() => {
                    if (this.el.debug) this.el.debug.classList.toggle('bt-show');
                }, 800);
            }, { passive: true });
            this.el.bar.addEventListener('touchend', () => clearTimeout(pressTimer), { passive: true });
        }

        // ==========================================
        //  UI UPDATES
        // ==========================================

        setStatus(stateText, message, type) {
            if (this._destroyed || !this.el.state) return;
            this.el.state.textContent = stateText;
            this.el.msg.textContent = message;
            this.el.bar.className = 'bt-' + type;

            if (type === 'success' || type === 'ready') {
                const detail = message.includes('\u2192') ? message.split('\u2192').pop().trim() : '';
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

        toggleMode() {
            this.intercepting = !this.intercepting;
            this.el.modeBtn.textContent = this.intercepting ? 'ON' : 'OFF';
            this.el.modeBtn.style.background = this.intercepting ? '#00e676' : '#ff4444';
            this.el.modeBtn.style.color = this.intercepting ? '#000' : '#fff';
            if (this.intercepting) {
                this.setStatus('SCAN BAG', 'Ready', 'idle');
            } else {
                this.setStatus('PASSTHROUGH', 'Scans go to Dolphin', 'pending');
                this.state = 'READY';
                this.currentBag = null;
            }
            this.log('Mode: ' + (this.intercepting ? 'INTERCEPTING' : 'PASSTHROUGH'));
        }

        updateTokenDot() {
            if (this._destroyed) return;
            if (this.el.tokenDot) {
                this.el.tokenDot.classList.toggle('bt-live', !!this.token);
            }
        }

        addHistory(bag, dest, isError) {
            if (this._destroyed) return;
            this.history.unshift({ bag, dest, isError });
            if (this.history.length > 50) this.history.pop();
            if (!this.el.historyPanel) return;
            this.el.historyPanel.innerHTML = this.history.map(h =>
                '<div class="bt-hist-row">' +
                    '<span class="bt-hist-bag">' + h.bag + '</span>' +
                    '<span class="bt-hist-dest' + (h.isError ? ' bt-err' : '') + '">' + h.dest + '</span>' +
                '</div>'
            ).join('');
        }

        copyHistory() {
            const lines = this.history.map(h =>
                h.bag + ' -> ' + h.dest + (h.isError ? ' [ERROR]' : '')
            ).join('\n');
            const debugLines = this.el.debug ? this.el.debug.textContent : '';
            const output = '=== BAG HISTORY ===\n' + (lines || '(empty)') + '\n\n=== DEBUG LOG ===\n' + debugLines;

            navigator.clipboard.writeText(output).then(() => {
                if (this.el.copyBtn) {
                    this.el.copyBtn.textContent = 'COPIED';
                    setTimeout(() => { if (this.el.copyBtn) this.el.copyBtn.textContent = 'COPY LOG'; }, 1500);
                }
            }).catch(() => {
                const ta = document.createElement('textarea');
                ta.value = output;
                document.body.appendChild(ta);
                ta.select();
                document.execCommand('copy');
                ta.remove();
                if (this.el.copyBtn) {
                    this.el.copyBtn.textContent = 'COPIED';
                    setTimeout(() => { if (this.el.copyBtn) this.el.copyBtn.textContent = 'COPY LOG'; }, 1500);
                }
            });
        }

        playSound(type) {
            try {
                const ctx = new (window.AudioContext || window.webkitAudioContext)();
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.connect(gain);
                gain.connect(ctx.destination);

                if (type === 'success') {
                    osc.frequency.value = 880;
                    gain.gain.value = 0.3;
                    osc.start();
                    osc.frequency.setValueAtTime(1108, ctx.currentTime + 0.1);
                    gain.gain.setValueAtTime(0, ctx.currentTime + 0.2);
                    osc.stop(ctx.currentTime + 0.2);
                } else if (type === 'error') {
                    osc.frequency.value = 300;
                    gain.gain.value = 0.4;
                    osc.start();
                    osc.frequency.setValueAtTime(200, ctx.currentTime + 0.15);
                    gain.gain.setValueAtTime(0, ctx.currentTime + 0.4);
                    osc.stop(ctx.currentTime + 0.4);
                } else if (type === 'scan') {
                    osc.frequency.value = 1200;
                    gain.gain.value = 0.15;
                    osc.start();
                    gain.gain.setValueAtTime(0, ctx.currentTime + 0.05);
                    osc.stop(ctx.currentTime + 0.05);
                }
            } catch (e) { }
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

    window.BagTool = BagTool;
})();