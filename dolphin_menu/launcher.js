(function () {
    'use strict';

    const LAUNCHER_VERSION = '1.1';
    const BASE_URL = 'https://nlovitt.github.io/dolphin/';

    if (window.__launcher) {
        window.__launcher.showMenu();
        return;
    }

    class Launcher {
        constructor() {
            this.token = null;
            this.tokenTimestamp = null;
            this.activeTool = null;
            this.activeToolName = null;
            this._tokenCallbacks = [];
            this.el = {};

            this.patchXHR();
            this.patchFetch();
            this.patchFocus();
            this.injectStyles();
            this.buildUI();
            this.showMenu();
            console.log('[Launcher] Ready v' + LAUNCHER_VERSION);
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
                    self._notifyToken();
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
                        if (t) {
                            self.token = t;
                            self.tokenTimestamp = Date.now();
                            self._notifyToken();
                        }
                    } else if (typeof h === 'object' && !Array.isArray(h)) {
                        Object.keys(h).forEach(k => {
                            if (k.toLowerCase() === 'x-amz-access-token') {
                                self.token = h[k];
                                self.tokenTimestamp = Date.now();
                                self._notifyToken();
                            }
                        });
                    }
                }
                return orig.apply(this, arguments);
            };
        }

        patchFocus() {
            const self = this;
            this._origFocus = HTMLElement.prototype.focus;
            HTMLElement.prototype.focus = function (options) {
                if (self.activeTool &&
                    typeof self.activeTool.shouldBlockFocus === 'function' &&
                    self.activeTool.shouldBlockFocus(this)) {
                    return;
                }
                return self._origFocus.call(this, options);
            };
        }

        // ==========================================
        //  TOKEN CALLBACKS
        // ==========================================

        _notifyToken() {
            this.updateMenuToken();
            this._tokenCallbacks.forEach(cb => {
                try { cb(this.token, this.tokenTimestamp); } catch (e) { }
            });
        }

        onTokenChange(cb) {
            this._tokenCallbacks.push(cb);
            return () => {
                this._tokenCallbacks = this._tokenCallbacks.filter(c => c !== cb);
            };
        }

        updateMenuToken() {
            if (!this.el.dot) return;
            const has = !!this.token;
            this.el.dot.classList.toggle('lt-live', has);

            if (has) {
                const mins = Math.floor((Date.now() - this.tokenTimestamp) / 60000);
                this.el.tokenLabel.textContent = 'Token captured (' + mins + 'm ago)';
                this.el.passMsg.textContent = 'Token ready \u2014 pick a tool below';
                this.el.passMsg.style.color = '#69f0ae';
                this.el.passDot.classList.add('lt-captured');
            } else {
                this.el.tokenLabel.textContent = 'No token';
                this.el.passMsg.textContent = 'Scan something in Dolphin to capture token';
                this.el.passMsg.style.color = '#ffd740';
                this.el.passDot.classList.remove('lt-captured');
            }
        }

        // ==========================================
        //  STYLES
        // ==========================================

        injectStyles() {
            if (document.getElementById('lt-styles')) return;
            const style = document.createElement('style');
            style.id = 'lt-styles';
            style.textContent = `
                #lt-fab {
                    position: fixed;
                    bottom: 20px;
                    right: 20px;
                    width: 56px;
                    height: 56px;
                    border-radius: 50%;
                    background: #232f3e;
                    color: #ff9900;
                    border: 2px solid #ff9900;
                    font-size: 24px;
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

                #lt-overlay {
                    position: fixed;
                    top: 0; left: 0; right: 0; bottom: 0;
                    background: rgba(0,0,0,0.85);
                    z-index: 2147483646;
                    display: none;
                    align-items: center;
                    justify-content: center;
                    padding: 20px;
                }
                #lt-overlay.lt-show { display: flex; }

                #lt-menu {
                    background: #1a1a2e;
                    border: 2px solid #ff9900;
                    border-radius: 16px;
                    padding: 24px;
                    width: 100%;
                    max-width: 320px;
                    box-shadow: 0 8px 40px rgba(0,0,0,0.8);
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                }

                .lt-header { text-align: center; margin-bottom: 16px; }
                .lt-title {
                    font-size: 22px;
                    font-weight: 800;
                    color: #ff9900;
                    margin-bottom: 4px;
                }

                .lt-token-row {
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    gap: 8px;
                    font-size: 12px;
                    color: #888;
                    margin-bottom: 12px;
                }
                .lt-dot {
                    width: 10px; height: 10px;
                    border-radius: 50%;
                    background: #ff4444;
                    transition: background 0.3s;
                }
                .lt-dot.lt-live { background: #00e676; }

                .lt-passthrough-banner {
                    background: #16213e;
                    border: 1px solid #1a4a7a;
                    border-radius: 10px;
                    padding: 12px 14px;
                    margin-bottom: 18px;
                    text-align: center;
                }
                .lt-pass-header {
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    gap: 8px;
                    margin-bottom: 6px;
                }
                .lt-pass-dot {
                    width: 10px; height: 10px;
                    border-radius: 50%;
                    background: #ffd740;
                    animation: lt-pulse 1.5s ease-in-out infinite;
                    flex-shrink: 0;
                }
                .lt-pass-dot.lt-captured {
                    background: #00e676;
                    animation: none;
                }
                @keyframes lt-pulse {
                    0%, 100% { opacity: 1; }
                    50% { opacity: 0.3; }
                }
                .lt-pass-label {
                    font-size: 12px;
                    font-weight: 800;
                    color: #ffd740;
                    text-transform: uppercase;
                    letter-spacing: 1px;
                }
                .lt-pass-msg {
                    font-size: 11px;
                    color: #ffd740;
                    line-height: 1.4;
                }

                .lt-tool-btn {
                    display: flex;
                    align-items: center;
                    width: 100%;
                    padding: 16px 20px;
                    margin-bottom: 12px;
                    background: #0f3460;
                    border: 1px solid #1a4a7a;
                    border-radius: 12px;
                    color: #fff;
                    font-size: 18px;
                    font-weight: 700;
                    cursor: pointer;
                    touch-action: manipulation;
                    -webkit-tap-highlight-color: transparent;
                    transition: background 0.2s, border-color 0.2s;
                    gap: 14px;
                    box-sizing: border-box;
                }
                .lt-tool-btn:active {
                    background: #1a4a7a;
                    border-color: #ff9900;
                }
                .lt-tool-icon { font-size: 28px; flex-shrink: 0; }
                .lt-tool-info { text-align: left; }
                .lt-tool-name { font-size: 16px; font-weight: 800; }
                .lt-tool-desc { font-size: 11px; color: #888; margin-top: 2px; }

                .lt-close-btn {
                    display: block;
                    width: 100%;
                    padding: 10px;
                    background: none;
                    border: 1px solid #333;
                    border-radius: 8px;
                    color: #666;
                    font-size: 13px;
                    cursor: pointer;
                    touch-action: manipulation;
                    margin-top: 4px;
                    box-sizing: border-box;
                }
                .lt-ver {
                    text-align: center;
                    font-size: 9px;
                    color: #333;
                    margin-top: 12px;
                }
            `;
            document.head.appendChild(style);
        }

        // ==========================================
        //  BUILD UI
        // ==========================================

        buildUI() {
            const fab = document.createElement('button');
            fab.id = 'lt-fab';
            fab.textContent = '\uD83D\uDC2C';
            fab.addEventListener('click', (e) => {
                e.stopPropagation();
                this.showMenu();
            });
            document.body.appendChild(fab);
            this.el.fab = fab;

            const overlay = document.createElement('div');
            overlay.id = 'lt-overlay';
            overlay.innerHTML = `
                <div id="lt-menu">
                    <div class="lt-header">
                        <div class="lt-title">\uD83D\uDC2C Dolphin Tools</div>
                        <div class="lt-token-row">
                            <div class="lt-dot" id="lt-dot"></div>
                            <span id="lt-token-label">No token</span>
                        </div>
                    </div>

                    <div class="lt-passthrough-banner">
                        <div class="lt-pass-header">
                            <div class="lt-pass-dot" id="lt-pass-dot"></div>
                            <span class="lt-pass-label">\uD83D\uDCE1 Passthrough Active</span>
                        </div>
                        <div class="lt-pass-msg" id="lt-pass-msg">
                            Scan something in Dolphin to capture token
                        </div>
                    </div>

                    <button class="lt-tool-btn" id="lt-btn-induct">
                        <span class="lt-tool-icon">\uD83D\uDCE6</span>
                        <div class="lt-tool-info">
                            <div class="lt-tool-name">Induct Tool</div>
                            <div class="lt-tool-desc">Scan & induct packages to sort locations</div>
                        </div>
                    </button>
                    <button class="lt-tool-btn" id="lt-btn-bag">
                        <span class="lt-tool-icon">\uD83D\uDC5C</span>
                        <div class="lt-tool-info">
                            <div class="lt-tool-name">Bag Tool</div>
                            <div class="lt-tool-desc">Link bags to destination locations</div>
                        </div>
                    </button>
                    <button class="lt-close-btn" id="lt-close">Close</button>
                    <div class="lt-ver">v${LAUNCHER_VERSION}</div>
                </div>
            `;
            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) this.hideMenu();
            });
            document.body.appendChild(overlay);

            this.el.overlay = overlay;
            this.el.dot = document.getElementById('lt-dot');
            this.el.tokenLabel = document.getElementById('lt-token-label');
            this.el.passDot = document.getElementById('lt-pass-dot');
            this.el.passMsg = document.getElementById('lt-pass-msg');

            document.getElementById('lt-btn-induct').addEventListener('click', (e) => {
                e.stopPropagation();
                this.loadTool('dolphin');
            });
            document.getElementById('lt-btn-bag').addEventListener('click', (e) => {
                e.stopPropagation();
                this.loadTool('bag');
            });
            document.getElementById('lt-close').addEventListener('click', (e) => {
                e.stopPropagation();
                this.hideMenu();
            });

            this.updateMenuToken();
        }

        // ==========================================
        //  MENU CONTROL
        // ==========================================

        showMenu() {
            this.destroyActiveTool();
            this.updateMenuToken();
            this.el.overlay.classList.add('lt-show');
            this.el.fab.style.display = 'none';
            console.log('[Launcher] Menu shown, activeTool=' + this.activeToolName);
        }

        hideMenu() {
            this.el.overlay.classList.remove('lt-show');
            // Only show FAB if no tool is active and we're not in the middle of loading one
            if (!this.activeTool && !this._loading) {
                this.el.fab.style.display = 'flex';
            }
        }

        // ==========================================
        //  TOOL LIFECYCLE
        // ==========================================

         destroyActiveTool() {
            console.log('[Launcher] destroyActiveTool: ' + this.activeToolName);

            if (this.activeTool) {
                try {
                    this.activeTool.destroy();
                } catch (e) {
                    console.error('[Launcher] destroy error:', e);
                }
                this.activeTool = null;
                this.activeToolName = null;
            }

            // Brute force cleanup — remove ALL orphaned tool DOM
            ['bt-bar', 'dt-panel'].forEach(id => {
                let el = document.getElementById(id);
                while (el) {
                    el.remove();
                    el = document.getElementById(id);
                }
            });
            ['bt-styles', 'dt-styles'].forEach(id => {
                let el = document.getElementById(id);
                while (el) {
                    el.remove();
                    el = document.getElementById(id);
                }
            });

            console.log('[Launcher] Cleanup done. bt-bar exists: ' +
                !!document.getElementById('bt-bar') +
                ', dt-panel exists: ' + !!document.getElementById('dt-panel'));
        }

         async loadTool(name) {
            console.log('[Launcher] loadTool: ' + name);

            // Destroy anything currently active
            this.destroyActiveTool();

            // Hide menu and FAB before creating tool
            this.el.overlay.classList.remove('lt-show');
            this.el.fab.style.display = 'none';

            try {
                if (name === 'dolphin') {
                    if (!window.DolphinTool) {
                        console.log('[Launcher] Loading dolphin-tool.js...');
                        await this._loadScript(BASE_URL + 'dolphin-tool.js?v=' + Date.now());
                    }
                    console.log('[Launcher] Creating DolphinTool instance...');
                    this.activeTool = new window.DolphinTool(this);
                    this.activeToolName = 'dolphin';
                } else if (name === 'bag') {
                    if (!window.BagTool) {
                        console.log('[Launcher] Loading bag-tool.js...');
                        await this._loadScript(BASE_URL + 'bag-tool.js?v=' + Date.now());
                    }
                    console.log('[Launcher] Creating BagTool instance...');
                    this.activeTool = new window.BagTool(this);
                    this.activeToolName = 'bag';
                }
                console.log('[Launcher] Loaded OK: ' + name);
            } catch (err) {
                console.error('[Launcher] Failed to load ' + name + ':', err);
                this.activeTool = null;
                this.activeToolName = null;
                this.el.fab.style.display = 'flex';
            }
        }
        _loadScript(url) {
            return new Promise((resolve, reject) => {
                const s = document.createElement('script');
                s.src = url;
                s.onload = resolve;
                s.onerror = () => reject(new Error('Failed to load: ' + url));
                document.head.appendChild(s);
            });
        }

        goBack() {
            console.log('[Launcher] goBack called');
            this.destroyActiveTool();
            this.updateMenuToken();
            this.el.overlay.classList.add('lt-show');
            this.el.fab.style.display = 'none';
        }
    }

    window.__launcher = new Launcher();
})();