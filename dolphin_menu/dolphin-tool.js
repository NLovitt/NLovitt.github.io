(function () {
    'use strict';

    const DT_VERSION = '2.0';

    class DolphinTool {
        constructor(launcher) {
            this.launcher = launcher;
            this.isOpen = true;
            this.history = [];
            this.el = {};
            this._unsubToken = null;
            this._ageInterval = null;
            this._destroyed = false;

            this.injectStyles();
            this.buildUI();
            this.bindEvents();
            this.updateTokenStatus();

            this._unsubToken = this.launcher.onTokenChange(() => {
                if (!this._destroyed) this.updateTokenStatus();
            });

            this.log('Initialized');
            this.log('URL: ' + window.location.href);
        }

        get token() {
            return this.launcher ? this.launcher.token : null;
        }

        get tokenTimestamp() {
            return this.launcher ? this.launcher.tokenTimestamp : null;
        }

        shouldBlockFocus(element) {
            return this.isOpen && this.el.panel && !this.el.panel.contains(element);
        }

        // ==========================================
        //  DESTROY
        // ==========================================

        destroy() {
            this._destroyed = true;
            this.isOpen = false;

            if (this._unsubToken) {
                this._unsubToken();
                this._unsubToken = null;
            }
            if (this._ageInterval) {
                clearInterval(this._ageInterval);
                this._ageInterval = null;
            }

            // Remove DOM
            if (this.el.panel) this.el.panel.remove();
            // Fallback
            const orphan = document.getElementById('dt-panel');
            if (orphan) orphan.remove();
            const style = document.getElementById('dt-styles');
            if (style) style.remove();

            this.el = {};
            this.launcher = null;
            console.log('[DT] Destroyed');
        }

        // ==========================================
        //  API
        // ==========================================

        async inductPackage(trackingId, inductLocation, isVolumetric = false) {
            if (!this.token) throw new Error('No token \u2014 interact with Dolphin first');

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

            if (!res.ok) throw new Error('HTTP ' + res.status);
            return await res.json();
        }

        // ==========================================
        //  STYLES
        // ==========================================

        injectStyles() {
            if (document.getElementById('dt-styles')) return;
            const style = document.createElement('style');
            style.id = 'dt-styles';
            style.textContent = `
                #dt-panel {
                    position: fixed;
                    top: 0; left: 0; right: 0; bottom: 0;
                    background: #1a1a2e;
                    color: #e0e0e0;
                    z-index: 2147483646;
                    display: flex;
                    flex-direction: column;
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                    font-size: 14px;
                    overflow: hidden;
                }

                .dt-header {
                    display: flex;
                    align-items: center;
                    padding: 12px 16px;
                    background: #16213e;
                    flex-shrink: 0;
                    border-bottom: 2px solid #ff9900;
                }
                .dt-back {
                    background: none;
                    border: none;
                    color: rgba(255,255,255,0.7);
                    font-size: 20px;
                    cursor: pointer;
                    padding: 4px 12px 4px 0;
                    touch-action: manipulation;
                    -webkit-tap-highlight-color: transparent;
                    flex-shrink: 0;
                }
                .dt-title {
                    font-size: 16px;
                    font-weight: 700;
                    color: #ff9900;
                    flex: 1;
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
                    width: 8px; height: 8px;
                    border-radius: 50%;
                    background: #ff4444;
                    transition: background 0.3s;
                }
                .dt-dot.dt-live { background: #00e676; }

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
                }
                textarea.dt-input {
                    resize: vertical;
                    min-height: 80px;
                    line-height: 1.4;
                }
                .dt-input:focus { border-color: #ff9900; }
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
                    border-top: 1px solid #222;
                }
            `;
            document.head.appendChild(style);
        }

        // ==========================================
        //  BUILD UI
        // ==========================================

        buildUI() {
            const panel = document.createElement('div');
            panel.id = 'dt-panel';
            panel.innerHTML = `
                <div class="dt-header">
                    <button class="dt-back" id="dt-back">\u25C0 MENU</button>
                <span class="dt-title">\uD83D\uDCE6 Induct Tool</span>
                    <div class="dt-token-badge">
                        <div class="dt-dot" id="dt-dot"></div>
                        <span id="dt-token-label">No token</span>
                    </div>
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

                    <button id="dt-copy-debug" style="
                        width:100%;
                        background:none;
                        border:1px solid rgba(255,255,255,0.1);
                        color:rgba(255,255,255,0.3);
                        font-size:10px;
                        padding:4px;
                        margin-top:4px;
                        cursor:pointer;
                        border-radius:4px;
                    ">COPY DEBUG LOG</button>
                </div>

                <div class="dt-footer" id="dt-footer">
                    Interact with Dolphin to capture token \u00B7 v${DT_VERSION}
                </div>
            `;
            document.body.appendChild(panel);
            this.el.panel = panel;

            this.el.dot = document.getElementById('dt-dot');
            this.el.tokenLabel = document.getElementById('dt-token-label');
            this.el.tba = document.getElementById('dt-tba');
            this.el.loc = document.getElementById('dt-loc');
            this.el.goBtn = document.getElementById('dt-go');
            this.el.result = document.getElementById('dt-result');
            this.el.sort = document.getElementById('dt-sort');
            this.el.details = document.getElementById('dt-details');
            this.el.history = document.getElementById('dt-history');
            this.el.footer = document.getElementById('dt-footer');
            this.el.backBtn = document.getElementById('dt-back');
            this.el.debugLog = document.getElementById('dt-debug-log');
            this.el.copyBtn = document.getElementById('dt-copy-debug');
        }

        // ==========================================
        //  EVENTS
        // ==========================================

        bindEvents() {
            ['click', 'touchstart', 'touchend'].forEach(evt => {
                this.el.panel.addEventListener(evt, e => {
                    e.stopPropagation();
                }, false);
            });

            this.el.backBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (this.launcher) this.launcher.goBack();
            });

            this.el.goBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.handleInduct();
            });

            this.el.tba.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && e.ctrlKey) this.handleInduct();
            });

            this.el.copyBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.copyDebug();
            });

            this._ageInterval = setInterval(() => {
                if (!this._destroyed) this.updateTokenAge();
            }, 15000);
        }

        // ==========================================
        //  UI LOGIC
        // ==========================================

        updateTokenStatus() {
            if (this._destroyed || !this.el.dot) return;
            const has = !!this.token;
            this.el.dot.classList.toggle('dt-live', has);
            this.el.tokenLabel.textContent = has ? 'Token ready' : 'No token';
            this.el.goBtn.disabled = !has;
            this.updateTokenAge();
        }

        updateTokenAge() {
            if (this._destroyed || !this.el.footer) return;
            if (!this.tokenTimestamp) {
                this.el.footer.textContent = 'Interact with Dolphin to capture token \u00B7 v' + DT_VERSION;
                return;
            }
            const mins = Math.floor((Date.now() - this.tokenTimestamp) / 60000);
            const warn = mins >= 45;
            this.el.footer.textContent = 'Token age: ' + mins + 'm' + (warn ? ' \u26A0\uFE0F refresh soon' : '') + ' \u00B7 v' + DT_VERSION;
            this.el.footer.style.color = warn ? '#ff4444' : '#444';
        }

        // ==========================================
        //  INDUCT
        // ==========================================

        async handleInduct() {
            if (this._destroyed) return;
            const raw = this.el.tba.value.trim();
            const loc = this.el.loc.value.trim();

            if (!raw) return;
            if (!this.token) {
                this.showResult('NO TOKEN', true, 'Use Dolphin normally first so the tool can capture the auth token.');
                return;
            }

            const tbas = raw.split(/[\n,]+/)
                .map(t => t.trim())
                .filter(t => t.length > 0);

            if (tbas.length === 0) return;

            document.activeElement?.blur();
            this.el.goBtn.disabled = true;
            this.el.goBtn.textContent = 'INDUCTING 0/' + tbas.length;
            this.el.result.classList.remove('dt-show');

            let successCount = 0;
            let errorCount = 0;

            for (let i = 0; i < tbas.length; i++) {
                if (this._destroyed) return;
                const tba = tbas[i];
                this.el.goBtn.textContent = 'INDUCTING ' + (i + 1) + '/' + tbas.length;
                this.log('Inducting ' + (i + 1) + '/' + tbas.length + ': ' + tba);

                try {
                    const data = await this.inductPackage(tba, loc);
                    if (this._destroyed) return;
                    this.processResult(tba, data);
                    successCount++;
                } catch (err) {
                    if (this._destroyed) return;
                    this.showResult('ERROR', true, tba + ': ' + err.message);
                    this.addHistory(tba, 'ERR', true);
                    errorCount++;
                }

                if (i < tbas.length - 1) {
                    await new Promise(r => setTimeout(r, 300));
                }
            }

            if (this._destroyed) return;
            this.el.goBtn.disabled = false;
            this.el.goBtn.textContent = 'INDUCT';
            this.log('Batch done: ' + successCount + ' ok, ' + errorCount + ' errors');
        }

        processResult(tba, data) {
            if (this._destroyed) return;
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
                '<div class="dt-row"><span>' + k + '</span><span class="dt-val">' + v + '</span></div>'
            ).join('');

            this.showResult(sortLoc, isErr, html);
            this.addHistory(tba, sortLoc, isErr);
        }

        showResult(location, isError, detailsHtml) {
            if (this._destroyed) return;
            this.el.sort.textContent = location;
            this.el.sort.className = 'dt-sort-loc ' + (isError ? 'dt-err' : 'dt-ok');
            this.el.details.innerHTML = detailsHtml;
            this.el.result.classList.add('dt-show');
        }

        addHistory(tba, location, isError) {
            if (this._destroyed) return;
            this.history.unshift({ tba, location, isError, time: new Date() });
            if (this.history.length > 50) this.history.pop();
            this.renderHistory();
        }

        renderHistory() {
            if (this._destroyed || !this.el.history) return;
            this.el.history.innerHTML = this.history.map(h =>
                '<div class="dt-hist-item">' +
                '<span class="dt-hist-tba">' + h.tba + '</span>' +
                '<span class="dt-hist-loc ' + (h.isError ? 'dt-err' : 'dt-ok') + '">' + h.location + '</span>' +
                '</div>'
            ).join('');
        }

        copyDebug() {
            const debugText = this.el.debugLog ? this.el.debugLog.textContent : '';
            const historyText = this.history.map(h =>
                h.tba + ' -> ' + h.location + (h.isError ? ' [ERROR]' : '')
            ).join('\n');
            const output = '=== HISTORY ===\n' + (historyText || '(empty)') + '\n\n=== DEBUG ===\n' + debugText;

            navigator.clipboard.writeText(output).then(() => {
                if (this.el.copyBtn) {
                    this.el.copyBtn.textContent = 'COPIED';
                    setTimeout(() => { if (this.el.copyBtn) this.el.copyBtn.textContent = 'COPY DEBUG LOG'; }, 1500);
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
                    setTimeout(() => { if (this.el.copyBtn) this.el.copyBtn.textContent = 'COPY DEBUG LOG'; }, 1500);
                }
            });
            this.log('Copied to clipboard');
        }

        log(msg) {
            const ts = new Date().toLocaleTimeString();
            const entry = '[' + ts + '] ' + msg;
            console.log('[DT] ' + entry);
            if (this.el.debugLog) {
                this.el.debugLog.textContent = entry + '\n' + this.el.debugLog.textContent;
                const lines = this.el.debugLog.textContent.split('\n');
                if (lines.length > 30) {
                    this.el.debugLog.textContent = lines.slice(0, 30).join('\n');
                }
            }
        }
    }

    window.DolphinTool = DolphinTool;
})();