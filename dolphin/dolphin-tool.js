(function () {
    'use strict';

    const DT_VERSION = '1.9';

    if (window.__dolphinTool) {
        window.__dolphinTool.toggle();
        return;
    }

    class DolphinTool {
        constructor() {
            this.token = null;
            this.tokenTimestamp = null;
            this.isOpen = false;
            this.history = [];
            this.el = {};
            this.init();
        }

        init() {
            this.patchXHR();
            this.patchFetch();
            this.patchFocus();
            this.injectStyles();
            this.buildUI();
            this.bindEvents();
            this.updateTokenStatus();
            this.log('Initialized — waiting for token...');
            this.log('URL: ' + window.location.href);
            this.log('DOM inputs found: ' + document.querySelectorAll('input').length);
        }

        // ==========================================
        //  TOKEN INTERCEPTION
        // ==========================================

        patchXHR() {
            const self = this;
            const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;

            XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
                if (name.toLowerCase() === 'x-amz-access-token') {
                    self.captureToken(value, 'XHR');
                }
                return origSetHeader.apply(this, arguments);
            };
        }

        patchFetch() {
            const self = this;
            const origFetch = window.fetch;

            window.fetch = function (url, options) {
                if (options && options.headers) {
                    const h = options.headers;

                    if (h instanceof Headers) {
                        const t = h.get('x-amz-access-token');
                        if (t) self.captureToken(t, 'fetch/Headers');
                    } else if (Array.isArray(h)) {
                        h.forEach(([k, v]) => {
                            if (k.toLowerCase() === 'x-amz-access-token') {
                                self.captureToken(v, 'fetch/array');
                            }
                        });
                    } else if (typeof h === 'object') {
                        Object.keys(h).forEach(k => {
                            if (k.toLowerCase() === 'x-amz-access-token') {
                                self.captureToken(h[k], 'fetch/object');
                            }
                        });
                    }
                }
                return origFetch.apply(this, arguments);
            };
        }
        log(msg) {
            const ts = new Date().toLocaleTimeString();
            const entry = `[${ts}] ${msg}`;
            console.log('[DT] ' + entry);
            if (this.el.debugLog) {
                this.el.debugLog.textContent = entry + '\n' + this.el.debugLog.textContent;
                // Keep only last 30 lines
                const lines = this.el.debugLog.textContent.split('\n');
                if (lines.length > 30) {
                    this.el.debugLog.textContent = lines.slice(0, 30).join('\n');
                }
            }
        }
        loadQRLib() {
            return new Promise((resolve, reject) => {
                if (window.QRCode) return resolve();
                const s = document.createElement('script');
                s.src = 'https://cdn.jsdelivr.net/npm/qrcodejs@1.0.0/qrcode.min.js';
                s.onload = () => {
                    this.log('QR library loaded');
                    resolve();
                };
                s.onerror = () => reject(new Error('Failed to load QR library'));
                document.head.appendChild(s);
            });
        }

                async showTokenQR() {
            if (!this.token) {
                this.log('No token to export');
                return;
            }
            try {
                await this.loadQRLib();
            } catch (e) {
                this.log('QR lib failed: ' + e.message);
                return;
            }

            // Remove old overlay if exists
            const old = document.getElementById('dt-qr-overlay');
            if (old) old.remove();

            const overlay = document.createElement('div');
            overlay.id = 'dt-qr-overlay';
            overlay.style.cssText = `
                position: fixed; top: 0; left: 0; right: 0; bottom: 0;
                background: rgba(0,0,0,0.9); z-index: 2147483647;
                display: flex; flex-direction: column; align-items: center;
                justify-content: center; padding: 20px;
            `;
            overlay.innerHTML = `
                <div style="color: #ff9900; font-size: 16px; font-weight: 700; margin-bottom: 12px;">
                    Scan to Import Token
                </div>
                <div id="dt-qr-container" style="background: white; padding: 16px; border-radius: 12px;"></div>
                <div style="color: #666; font-size: 11px; margin-top: 12px; text-align: center;">
                    Token: ${this.token.substring(0, 20)}...<br>
                    Tap anywhere to close
                </div>
            `;
            overlay.addEventListener('click', () => overlay.remove());
            document.body.appendChild(overlay);

            new QRCode(document.getElementById('dt-qr-container'), {
                text: JSON.stringify({ t: this.token, ts: this.tokenTimestamp }),
                width: 220,
                height: 220,
                colorDark: '#000000',
                colorLight: '#ffffff',
                correctLevel: QRCode.CorrectLevel.L
            });
            this.log('Token QR displayed');
        }

        importToken(jsonStr) {
            try {
                const data = JSON.parse(jsonStr);
                if (data.t) {
                    this.token = data.t;
                    this.tokenTimestamp = data.ts || Date.now();
                    this.updateTokenStatus();
                    this.log('Token imported successfully');
                    return true;
                }
            } catch (e) {
                this.log('Import failed: ' + e.message);
            }
            return false;
        }

         patchFocus() {
            const self = this;
            const origFocus = HTMLElement.prototype.focus;

            HTMLElement.prototype.focus = function (options) {
                if (self.isOpen && self.el.panel && !self.el.panel.contains(this)) {
                    return;
                }
                return origFocus.call(this, options);
            };
            this.log('Patched HTMLElement.focus()');
        }

        captureToken(token, source) {
            this.token = token;
            this.tokenTimestamp = Date.now();
            this.updateTokenStatus();
            this.log(`Token captured via ${source}: ${token.substring(0, 20)}...`);
        }

        // ==========================================
        //  API CALLS
        // ==========================================

        async inductPackage(trackingId, inductLocation, isVolumetric = false) {
            if (!this.token) throw new Error('No token — interact with Dolphin first');

            const res = await fetch('https://dolphin.amazon.com/nis/package/induct', {
                method: 'POST',
                headers: {
                    'Accept': 'application/json, text/plain, */*',
                    'Content-Type': 'application/json;charset=utf-8',
                    'x-amz-access-token': this.token
                },
                body: JSON.stringify({
                    trackingId: trackingId.trim(),
                    inductLocation: inductLocation.trim(),
                    isVolumetricPackage: isVolumetric
                })
            });

            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return await res.json();
        }

        // ==========================================
        //  STYLES
        // ==========================================

        injectStyles() {
            const style = document.createElement('style');
            style.id = 'dt-styles';
            style.textContent = `
                #dt-fab {
                    position: fixed;
                    bottom: 20px;
                    right: 20px;
                    width: 56px;
                    height: 56px;
                    border-radius: 50%;
                    background: #232f3e;
                    color: #ff9900;
                    border: 2px solid #ff9900;
                    font-size: 18px;
                    font-weight: 800;
                    cursor: pointer;
                    z-index: 2147483647;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    box-shadow: 0 4px 15px rgba(0,0,0,0.5);
                    touch-action: manipulation;
                    -webkit-tap-highlight-color: transparent;
                    user-select: none;
                }

                #dt-panel {
                    position: fixed;
                    bottom: 0;
                    left: 0;
                    right: 0;
                    height: 400px;
                    background: #1a1a2e;
                    color: #e0e0e0;
                    z-index: 2147483646;
                    border-top: 3px solid #ff9900;
                    border-radius: 16px 16px 0 0;
                    transform: translateY(100%);
                    transition: transform 0.3s ease;
                    display: flex;
                    flex-direction: column;
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                    font-size: 14px;
                    box-shadow: 0 -4px 30px rgba(0,0,0,0.6);
                    overflow: visible;
                }
                #dt-panel.dt-open {
                    transform: translateY(0);
                }

                .dt-header {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    padding: 12px 16px;
                    background: #16213e;
                    border-radius: 16px 16px 0 0;
                    flex-shrink: 0;
                }
                .dt-title {
                    font-size: 16px;
                    font-weight: 700;
                    color: #ff9900;
                }
                .dt-token-badge {
                    display: flex;
                    align-items: center;
                    gap: 6px;
                    font-size: 11px;
                    color: #888;
                    background: #0d1b3e;
                    padding: 4px 10px;
                    border-radius: 20px;
                }
                .dt-dot {
                    width: 8px;
                    height: 8px;
                    border-radius: 50%;
                    background: #ff4444;
                    transition: background 0.3s;
                }
                .dt-dot.dt-live { background: #00e676; }
                .dt-close {
                    background: none;
                    border: none;
                    color: #666;
                    font-size: 28px;
                    cursor: pointer;
                    padding: 0 4px;
                    line-height: 1;
                    touch-action: manipulation;
                    -webkit-tap-highlight-color: transparent;
                }

                .dt-body {
                    padding: 16px;
                    overflow-y: auto;
                    flex: 1;
                    -webkit-overflow-scrolling: touch;
                }
                .dt-section { margin-bottom: 16px; }
                .dt-section-label {
                    font-size: 10px;
                    text-transform: uppercase;
                    letter-spacing: 1.8px;
                    color: #ff9900;
                    margin-bottom: 8px;
                    font-weight: 700;
                }

                .dt-field { margin-bottom: 10px; }
                .dt-field label {
                    font-size: 12px;
                    color: #888;
                    margin-bottom: 4px;
                    display: block;
                }

                .dt-input {
                    width: 100%;
                    padding: 11px 12px;
                    background: #0f3460;
                    border: 1px solid #1a4a7a;
                    border-radius: 8px;
                    color: #fff;
                    font-size: 16px;
                    outline: none;
                    box-sizing: border-box;
                    transition: border-color 0.2s;
                    touch-action: manipulation;
                    /* NO -webkit-appearance: none */
                }
                textarea.dt-input {
                    resize: vertical;
                    min-height: 80px;
                    line-height: 1.4;
                }
                    
                .dt-input:focus {
                    border-color: #ff9900;
                }
                .dt-input::placeholder { color: #445; }

                .dt-btn {
                    width: 100%;
                    padding: 13px;
                    background: #ff9900;
                    color: #000;
                    border: none;
                    border-radius: 8px;
                    font-size: 16px;
                    font-weight: 800;
                    cursor: pointer;
                    transition: background 0.2s, opacity 0.2s;
                    touch-action: manipulation;
                    -webkit-tap-highlight-color: transparent;
                    margin-top: 4px;
                }
                .dt-btn:active { background: #e68a00; }
                .dt-btn:disabled {
                    background: #333;
                    color: #666;
                    cursor: not-allowed;
                }

                .dt-result {
                    background: #0f3460;
                    border-radius: 10px;
                    padding: 14px;
                    display: none;
                }
                .dt-result.dt-show { display: block; }

                .dt-sort-loc {
                    font-size: 36px;
                    font-weight: 900;
                    text-align: center;
                    padding: 14px 8px;
                    border-radius: 8px;
                    margin-bottom: 10px;
                    letter-spacing: 1px;
                }
                .dt-sort-loc.dt-ok {
                    background: #1b5e20;
                    color: #69f0ae;
                }
                .dt-sort-loc.dt-err {
                    background: #7f0000;
                    color: #ff8a80;
                }

                .dt-details { font-size: 12px; color: #999; }
                .dt-row {
                    display: flex;
                    justify-content: space-between;
                    padding: 3px 0;
                    border-bottom: 1px solid #1a1a3e;
                }
                .dt-row:last-child { border-bottom: none; }
                .dt-val { color: #e0e0e0; font-weight: 600; }

                .dt-loading {
                    text-align: center;
                    padding: 16px;
                    display: none;
                }
                .dt-spinner {
                    display: inline-block;
                    width: 24px;
                    height: 24px;
                    border: 3px solid #222;
                    border-top-color: #ff9900;
                    border-radius: 50%;
                    animation: dt-spin 0.7s linear infinite;
                }
                @keyframes dt-spin { to { transform: rotate(360deg); } }

                .dt-history { max-height: 200px; overflow-y: auto; }
                .dt-hist-item {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    padding: 8px 10px;
                    background: #0f3460;
                    border-radius: 6px;
                    margin-bottom: 4px;
                    font-size: 12px;
                }
                .dt-hist-tba {
                    font-family: 'Courier New', monospace;
                    color: #64b5f6;
                    font-size: 11px;
                }
                .dt-hist-loc { font-weight: 800; font-size: 14px; }
                .dt-hist-loc.dt-ok { color: #69f0ae; }
                .dt-hist-loc.dt-err { color: #ff8a80; }

                .dt-footer {
                    text-align: center;
                    font-size: 10px;
                    color: #444;
                    padding: 8px;
                    flex-shrink: 0;
                }
            `;
            document.head.appendChild(style);
        }

        // ==========================================
        //  BUILD UI
        // ==========================================

        buildUI() {
            const fab = document.createElement('button');
            fab.id = 'dt-fab';
            fab.textContent = '🐬';
            document.body.appendChild(fab);
            this.el.fab = fab;

            const panel = document.createElement('div');
            panel.id = 'dt-panel';
            panel.innerHTML = `
                <div class="dt-header">
                    <span class="dt-title">\u{1F42C} DolphinTool</span>
                    <div class="dt-token-badge">
                        <div class="dt-dot" id="dt-dot"></div>
                        <span id="dt-token-label">No token</span>
                    </div>
                    <button class="dt-close" id="dt-close">&times;</button>
                </div>

                <div class="dt-body">
                    <div class="dt-section">
                        <div class="dt-section-label">Induct Package</div>
                          <div class="dt-field">
                            <label>Tracking IDs (one per line)</label>
                            <textarea class="dt-input" id="dt-tba"
                                   inputmode="text"
                                   placeholder="TBA328968084975&#10;TBA328968084976&#10;TBA328968084977"
                                   autocomplete="off" autocorrect="off"
                                   autocapitalize="off" spellcheck="false"
                                   rows="4"></textarea>
                        </div>
                        <div class="dt-field">
                            <label>Induct Location</label>
                            <input class="dt-input" id="dt-loc" type="text"
                                   inputmode="text"
                                   value="URL1" placeholder="URL1">
                        </div>
                        <button class="dt-btn" id="dt-go" disabled>INDUCT</button>
                        <div style="display: flex; gap: 8px; margin-top: 8px;">
                            <button class="dt-btn" id="dt-export-qr" style="flex:1; background:#16213e; color:#ff9900; border:1px solid #ff9900; font-size:13px; padding:10px;">EXPORT TOKEN</button>
                            <button class="dt-btn" id="dt-import-qr" style="flex:1; background:#16213e; color:#ff9900; border:1px solid #ff9900; font-size:13px; padding:10px;">IMPORT TOKEN</button>
                        </div>
                    </div>

                    <div class="dt-loading" id="dt-loading">
                        <div class="dt-spinner"></div>
                    </div>

                    <div class="dt-section">
                        <div class="dt-section-label">Result</div>
                        <div class="dt-result" id="dt-result">
                            <div class="dt-sort-loc" id="dt-sort"></div>
                            <div class="dt-details" id="dt-details"></div>
                        </div>
                    </div>

                    <div class="dt-section">
                        <div class="dt-section-label">History</div>
                        <div class="dt-history" id="dt-history"></div>
                    </div>
                    <div class="dt-section">
                        <div class="dt-section-label">Debug Log</div>
                        <div id="dt-debug-log" style="
                            background: #000;
                            color: #0f0;
                            font-family: 'Courier New', monospace;
                            font-size: 10px;
                            padding: 8px;
                            border-radius: 6px;
                            max-height: 150px;
                            overflow-y: auto;
                            white-space: pre-wrap;
                            word-break: break-all;
                        "></div>
                    </div>
                </div>

                <div class="dt-footer" id="dt-footer">
                    Interact with Dolphin to capture token
                </div>
            `;
            document.body.appendChild(panel);
            this.el.panel = panel;

            this.el.dot = document.getElementById('dt-dot');
            this.el.tokenLabel = document.getElementById('dt-token-label');
            this.el.tba = document.getElementById('dt-tba');
            this.el.loc = document.getElementById('dt-loc');
            this.el.goBtn = document.getElementById('dt-go');
            this.el.loading = document.getElementById('dt-loading');
            this.el.result = document.getElementById('dt-result');
            this.el.sort = document.getElementById('dt-sort');
            this.el.details = document.getElementById('dt-details');
            this.el.history = document.getElementById('dt-history');
            this.el.footer = document.getElementById('dt-footer');
            this.el.close = document.getElementById('dt-close');
            this.el.exportQR = document.getElementById('dt-export-qr');
            this.el.importQR = document.getElementById('dt-import-qr');
            this.el.debugLog = document.getElementById('dt-debug-log');
        }

        // ==========================================
        //  EVENT BINDING
        // ==========================================

         bindEvents() {
            // Stop clicks/touches from reaching Dolphin
            ['click', 'touchstart', 'touchend'].forEach(evt => {
                this.el.panel.addEventListener(evt, e => {
                    e.stopPropagation();
                }, false);
            });

            this.el.fab.addEventListener('click', e => {
                e.stopPropagation();
                this.toggle();
            });
            this.el.close.addEventListener('click', e => {
                e.stopPropagation();
                this.toggle();
            });
            this.el.goBtn.addEventListener('click', e => {
                e.stopPropagation();
                this.handleInduct();
            });
            this.el.tba.addEventListener('keydown', e => {
                if (e.key === 'Enter' && e.ctrlKey) this.handleInduct();
            });
            this.el.exportQR.addEventListener('click', e => {
                e.stopPropagation();
                this.showTokenQR();
            });
            this.el.importQR.addEventListener('click', e => {
                e.stopPropagation();
                const input = prompt('Paste token JSON (from QR scan):');
                if (input) this.importToken(input);
            });
            
            setInterval(() => this.updateTokenAge(), 15000);
        }
        // ==========================================
        //  UI LOGIC
        // ==========================================

        toggle() {
            this.isOpen = !this.isOpen;
            this._ourInputActive = false;
            this.el.panel.classList.toggle('dt-open', this.isOpen);
            this.el.fab.style.display = this.isOpen ? 'none' : 'flex';
            this.log('Panel ' + (this.isOpen ? 'opened' : 'closed'));
        }

        updateTokenStatus() {
            if (!this.el.dot) return;
            const has = !!this.token;
            this.el.dot.classList.toggle('dt-live', has);
            this.el.tokenLabel.textContent = has ? 'Token ready' : 'No token';
            this.el.goBtn.disabled = !has;
            this.updateTokenAge();
        }

        updateTokenAge() {
            if (!this.el.footer) return;
            if (!this.tokenTimestamp) {
                this.el.footer.textContent = 'Interact with Dolphin to capture token \u00B7 v' + DT_VERSION;
                return;
            }
            const mins = Math.floor((Date.now() - this.tokenTimestamp) / 60000);
            const warn = mins >= 45;
            this.el.footer.textContent = `Token age: ${mins}m${warn ? ' \u26A0\uFE0F refresh soon' : ''} \u00B7 v${DT_VERSION}`;
            this.el.footer.style.color = warn ? '#ff4444' : '#444';
        }

        // ==========================================
        //  INDUCT HANDLER
        // ==========================================

         async handleInduct() {
            const raw = this.el.tba.value.trim();
            const loc = this.el.loc.value.trim();

            if (!raw) return;
            if (!this.token) {
                this.showResult('NO TOKEN', true, 'Use Dolphin normally first so the tool can capture the auth token.');
                return;
            }

            // Parse list — split by newlines, commas, or spaces
            const tbas = raw.split(/[\n,]+/)
                .map(t => t.trim())
                .filter(t => t.length > 0);

            if (tbas.length === 0) return;

            document.activeElement?.blur();
            this.el.goBtn.disabled = true;
            this.el.goBtn.textContent = `INDUCTING 0/${tbas.length}`;
            this.el.result.classList.remove('dt-show');

            let successCount = 0;
            let errorCount = 0;

            for (let i = 0; i < tbas.length; i++) {
                const tba = tbas[i];
                this.el.goBtn.textContent = `INDUCTING ${i + 1}/${tbas.length}`;
                this.log(`Inducting ${i + 1}/${tbas.length}: ${tba}`);

                try {
                    const data = await this.inductPackage(tba, loc);
                    this.processResult(tba, data);
                    successCount++;
                } catch (err) {
                    this.showResult('ERROR', true, `${tba}: ${err.message}`);
                    this.addHistory(tba, 'ERR', true);
                    errorCount++;
                }

                // Small delay between requests to avoid rate limiting
                if (i < tbas.length - 1) {
                    await new Promise(r => setTimeout(r, 300));
                }
            }

            this.el.goBtn.disabled = false;
            this.el.goBtn.textContent = 'INDUCT';
            this.log(`Batch done: ${successCount} ok, ${errorCount} errors`);
            // NOT clearing the textarea
        }

        processResult(tba, data) {
            const status = data?.userOutput?.displayOutput?.responseStatus;
            const code = data?.userOutput?.displayOutput?.responseCode;
            const sortLoc = data?.sortLocation || 'N/A';
            const isErr = status === 'ERROR';

            const rows = [];
            if (data.nodeId) rows.push(['Station', data.nodeId]);
            if (code) rows.push(['Code', code]);
            if (sortLoc !== 'N/A') rows.push(['Sort To', sortLoc]);

            const avery = data?.userOutput?.salPrintOutput?.AVERY_PRINTER;
            if (avery) {
                if (avery.LINE90 && avery.LINE90.trim()) rows.push(['Cycle', avery.LINE90.trim()]);
                if (avery.LINE9 && avery.LINE9.trim()) rows.push(['Note', avery.LINE9.trim()]);
            }

            if (data.packageIdentifiers && data.packageIdentifiers.length > 1) {
                rows.push(['Alt IDs', data.packageIdentifiers.filter(id => id !== tba).join(', ')]);
            }

            const html = rows.map(([k, v]) =>
                `<div class="dt-row"><span>${k}</span><span class="dt-val">${v}</span></div>`
            ).join('');

            this.showResult(sortLoc, isErr, html);
            this.addHistory(tba, sortLoc, isErr);
        }

        showResult(location, isError, detailsHtml) {
            this.el.sort.textContent = location;
            this.el.sort.className = 'dt-sort-loc ' + (isError ? 'dt-err' : 'dt-ok');
            this.el.details.innerHTML = detailsHtml;
            this.el.result.classList.add('dt-show');
        }

        addHistory(tba, location, isError) {
            this.history.unshift({ tba, location, isError, time: new Date() });
            if (this.history.length > 50) this.history.pop();
            this.renderHistory();
        }

        renderHistory() {
            this.el.history.innerHTML = this.history.map(h => `
                <div class="dt-hist-item">
                    <span class="dt-hist-tba">${h.tba}</span>
                    <span class="dt-hist-loc ${h.isError ? 'dt-err' : 'dt-ok'}">${h.location}</span>
                </div>
            `).join('');
        }
    }

    window.__dolphinTool = new DolphinTool();

})();

