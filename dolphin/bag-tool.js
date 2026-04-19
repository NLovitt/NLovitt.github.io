(function () {
    'use strict';

    const BT_VERSION = '2.10';

    if (window.__bagTool) return;

    // ==========================================
    //  LOCATION MAP BOOTSTRAP
    //  bt-locations.js defines BT_LOCATION_MAP.
    //  If not already loaded, inject it first, then re-run this script.
    // ==========================================

    if (typeof BT_LOCATION_MAP === 'undefined') {
        // Derive base URL from this script's own src tag
        const me = document.currentScript && document.currentScript.src;
        const base = me ? me.substring(0, me.lastIndexOf('/') + 1)
                       : 'https://nlovitt.github.io/dolphin/';
        const locSrc = base + 'bt-locations.js';
        const locScript = document.createElement('script');
        locScript.src = locSrc + '?v=' + Date.now();
        locScript.onload = function () {
            // bt-locations.js loaded — now (re-)run bag-tool
            const btScript = document.createElement('script');
            btScript.src = me ? (me + '?v=' + Date.now()) : (base + 'bag-tool.js?v=' + Date.now());
            document.head.appendChild(btScript);
        };
        locScript.onerror = function () {
            console.warn('[BT] Could not load bt-locations.js — guided mode will have no map');
            window.BT_LOCATION_MAP = {}; // ensure var exists so next run skips this block
            const btScript = document.createElement('script');
            btScript.src = me ? (me + '?v2=' + Date.now()) : (base + 'bag-tool.js?v2=' + Date.now());
            document.head.appendChild(btScript);
        };
        document.head.appendChild(locScript);
        return; // stop this invocation — the re-injected script will take over
    }

    // BT_LOCATION_MAP is available
    const LOCATION_MAP = BT_LOCATION_MAP;

    (function () {
        const count = Object.keys(LOCATION_MAP).length;
        if (count > 0) {
            console.log('[BT] Location map loaded: ' + count + ' entries');
        } else {
            console.warn('[BT] WARNING: BT_LOCATION_MAP not found — bt-locations.js may not be loaded');
        }
    })();

    // ==========================================
    //  GUIDED MODE — WALK LOGIC
    // ==========================================

    const AISLE_SUFFIXES = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
    const AISLE_TIERS    = [1, 2, 3, 4];

    /**
     * Parse a location label like "H-40" or "H-40.2C"
     * Returns { prefix:"H", bay:40, tier:2|null, suffix:"C"|null }
     */
    function parseLocationLabel(label) {
        const m = label.trim().match(/^([A-Za-z][A-Za-z0-9]*)-(\d+)(?:\.(\d)([A-Ga-g]))?$/);
        if (!m) return null;
        return {
            prefix: m[1].toUpperCase(),
            bay:    parseInt(m[2], 10),
            tier:   m[3] ? parseInt(m[3], 10) : null,
            suffix: m[4] ? m[4].toUpperCase() : null,
        };
    }

    /**
     * Build ordered walk list from a starting bay label.
     * Walk pattern per spec:
     *   all suffix-A positions descending by bay (40A→39A→...→1A),
     *   then all suffix-B  (40B→39B→...→1B), etc.
     *   Within each (bay, suffix): tier 1 → 2 → 3 (→ 4 if not skipped)
     *
     * Only includes entries that exist in LOCATION_MAP.
     */
    function buildWalkList(startLabel, skip4thTier) {
        const parsed = parseLocationLabel(startLabel);
        if (!parsed) return [];

        const { prefix, bay: startBay } = parsed;
        const tiers    = skip4thTier ? AISLE_TIERS.slice(0, 3) : AISLE_TIERS;
        const walkList = [];

        for (const suffix of AISLE_SUFFIXES) {
            for (let bay = startBay; bay >= 1; bay--) {
                for (const tier of tiers) {
                    const label = `${prefix}-${bay}.${tier}${suffix}`;
                    const scannableId = LOCATION_MAP[label];
                    if (scannableId) {
                        walkList.push({ label, scannableId });
                    }
                }
            }
        }

        return walkList;
    }

    /**
     * Resolve a scanned value to { label, scannableId }.
     * Handles:
     *   - display label (e.g. "H-40.1A") → direct lookup
     *   - raw scannableId (UUID) → reverse lookup for display label
     *   - unknown → used as-is
     */
    function resolveScannedLocation(scannedValue) {
        // Direct label lookup
        const byLabel = LOCATION_MAP[scannedValue];
        if (byLabel) return { label: scannedValue, scannableId: byLabel };

        // UUID / scannableId — reverse lookup
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(scannedValue)) {
            const label = Object.keys(LOCATION_MAP).find(k => LOCATION_MAP[k] === scannedValue);
            return { label: label || scannedValue, scannableId: scannedValue };
        }

        // Unknown — treat scanned value as the scannableId directly
        return { label: scannedValue, scannableId: scannedValue };
    }

    // ==========================================
    //  MAIN CLASS
    // ==========================================

    class BagTool {
        constructor() {
            this.token          = null;
            this.tokenTimestamp = null;

            // 'standard' | 'guided'
            this.mode           = 'standard';

            // standard mode
            this.state          = 'READY'; // READY | VALIDATING | AWAITING_LOCATION
            this.currentBag     = null;

            // guided mode
            this.guidedState    = 'SCAN_START'; // SCAN_START | WALKING
            this.walkList       = [];
            this.walkIndex      = 0;
            this.skip4thTier    = false;
            this.startLabel     = null;

            this.history        = [];
            this.el             = {};
            this.intercepting   = false;

            this.init();
        }

        init() {
            this.patchXHR();
            this.patchFetch();
            this.injectStyles();
            this.buildUI();
            this.bindScanner();

            const mapSize = Object.keys(LOCATION_MAP).length;
            this.log('Initialized v' + BT_VERSION + ' | map: ' + mapSize + ' locations');
            this.setStatus('PASSTHROUGH', 'Use Dolphin to get token, then tap ON', 'pending');
        }

        // ==========================================
        //  TOKEN INTERCEPTION
        // ==========================================

        patchXHR() {
            const self = this;
            const orig = XMLHttpRequest.prototype.setRequestHeader;
            XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
                if (name.toLowerCase() === 'x-amz-access-token') {
                    self.token          = value;
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
                                self.token = h[k];
                                self.tokenTimestamp = Date.now();
                                self.updateTokenDot();
                            }
                        });
                    }
                }
                return orig.apply(this, arguments);
            };
        }

        // ==========================================
        //  SCANNER INPUT
        // ==========================================

        bindScanner() {
            const self = this;
            document.addEventListener('keydown', function (e) {
                if ((e.key === 'Enter' || e.keyCode === 13) && self.intercepting) {
                    const active = document.activeElement;
                    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) {
                        const val = active.value.trim();
                        if (val.length > 3) {
                            e.preventDefault();
                            e.stopImmediatePropagation();
                            active.value = '';
                            self.processScan(val);
                        }
                    }
                }
            }, true);
        }

        // ==========================================
        //  SCAN ROUTING
        // ==========================================

        async processScan(value) {
            value = value.trim();
            this.log('Scanned: ' + value);

            if (this.mode === 'guided') {
                this.processGuidedScan(value);
            } else {
                if (this.state === 'READY' || this.state === 'VALIDATING') {
                    await this.handleBagScan(value);
                } else if (this.state === 'AWAITING_LOCATION') {
                    await this.handleLocationScan(value);
                }
            }
        }

        // ==========================================
        //  STANDARD MODE
        // ==========================================

        async handleBagScan(bagId) {
            this.state      = 'VALIDATING';
            this.currentBag = bagId;
            this.setStatus('VALIDATING', bagId, 'pending');

            if (!this.token) {
                this.setStatus('NO TOKEN', 'Use original app once first', 'error');
                this.state = 'READY';
                return;
            }

            try {
                const res = await fetch('https://dolphin.amazon.com/nss/open/validateBag', {
                    method:  'POST',
                    headers: {
                        'Accept':             'application/json, text/plain, */*',
                        'Content-Type':       'application/json;charset=utf-8',
                        'x-amz-access-token': this.token,
                    },
                    body: JSON.stringify({ bagScannableId: bagId, scope: 'AMZL' }),
                });

                if (!res.ok) throw new Error('HTTP ' + res.status + ' | ' + (await res.text()).substring(0, 200));
                const data = await res.json();

                if (data.responseCode === 'SUCCESS') {
                    const existing = data.existingDestinationLabel;
                    this.state = 'AWAITING_LOCATION';
                    this.setStatus('SCAN LOCATION',
                        bagId + (existing ? ' → currently: ' + existing : ' (no destination)'),
                        'ready');
                    this.playSound('scan');
                } else {
                    this.state = 'READY';
                    this.setStatus('BAG ERROR', data.responseCode || 'Unknown', 'error');
                    this.playSound('error');
                }
            } catch (err) {
                this.state = 'READY';
                this.setStatus('ERROR', err.message, 'error');
                this.playSound('error');
            }
        }

        async handleLocationScan(locationId) {
            if (!this.currentBag) { this.state = 'READY'; this.setStatus('ERROR', 'No bag scanned', 'error'); return; }
            if (!this.token)      { this.setStatus('NO TOKEN', 'Use original app once first', 'error'); return; }

            const bag = this.currentBag;
            this.currentBag = null;
            this.state = 'READY';
            this.setStatus('LINKING...', bag + ' → ' + locationId, 'pending');
            this.playSound('scan');
            this.linkBagAsync(bag, locationId);
        }

        // ==========================================
        //  LINK BAG (shared by both modes)
        // ==========================================

        linkBagAsync(bag, locationId, onSuccess, onError) {
            if (!this.token) {
                this.setStatus('NO TOKEN', 'Token expired — use Dolphin once', 'error');
                if (onError) onError('NO_TOKEN');
                return;
            }

            fetch('https://dolphin.amazon.com/nss/open/bag', {
                method:  'POST',
                headers: {
                    'Accept':             'application/json, text/plain, */*',
                    'Content-Type':       'application/json;charset=utf-8',
                    'x-amz-access-token': this.token,
                },
                body: JSON.stringify({
                    bagScannableId:         bag,
                    destinationScannableId: locationId,
                    scope:                  'AMZL',
                }),
            })
            .then(async res => {
                if (!res.ok) throw new Error('HTTP ' + res.status + ' | ' + (await res.text()).substring(0, 200));
                return res.json();
            })
            .then(data => {
                if (data.responseCode === 'SUCCESS') {
                    this.addHistory(data.bagLabel, data.destinationLabel, false);
                    this.playSound('success');
                    this.log('Linked: ' + data.bagLabel + ' → ' + data.destinationLabel);
                    if (onSuccess) {
                        onSuccess(data);
                    } else if (this.state === 'READY' && !this.currentBag) {
                        this.setStatus('SCAN BAG', 'Last: ' + data.bagLabel + ' → ' + data.destinationLabel, 'success');
                        setTimeout(() => {
                            if (this.state === 'READY' && !this.currentBag) {
                                this.setStatus('SCAN BAG', 'Ready', 'idle');
                            }
                        }, 2000);
                    }
                } else {
                    this.addHistory(bag, data.responseCode || 'ERROR', true);
                    this.playSound('error');
                    this.log('Link error: ' + (data.responseCode || 'unknown'));
                    if (onError) onError(data.responseCode);
                    else if (this.state === 'READY') this.setStatus('LINK ERROR', data.responseCode || 'Unknown', 'error');
                }
            })
            .catch(err => {
                this.addHistory(bag, 'ERR', true);
                this.playSound('error');
                this.log('open/bag failed: ' + err.message);
                if (onError) onError(err.message);
                else if (this.state === 'READY') this.setStatus('ERROR', err.message, 'error');
            });
        }

        // ==========================================
        //  GUIDED MODE — SCAN PROCESSING
        // ==========================================

        processGuidedScan(value) {
            if (this.guidedState === 'SCAN_START') {
                // Resolve the scanned location to a known label
                const loc = resolveScannedLocation(value);

                // Try to parse a bay-level label (e.g. "H-40") or position label (e.g. "H-40.2C")
                // If position label scanned, extract just the bay for walk generation
                let walkFromLabel = loc.label;
                const parsed = parseLocationLabel(loc.label);
                if (parsed && parsed.tier !== null) {
                    // User scanned a specific shelf — start walk from that bay
                    walkFromLabel = `${parsed.prefix}-${parsed.bay}`;
                }

                this.startLabel = walkFromLabel;
                this.walkList   = buildWalkList(walkFromLabel, this.skip4thTier);
                this.walkIndex  = 0;

                const mapSize = Object.keys(LOCATION_MAP).length;

                if (this.walkList.length > 0) {
                    this.guidedState = 'WALKING';
                    this.log('Walk started from ' + walkFromLabel + ' — ' + this.walkList.length + ' locations');
                    this.updateGuidedUI();
                } else if (mapSize === 0) {
                    this.setStatus('MAP ERROR', 'bt-locations.js not loaded! See console.', 'error');
                    this.log('ERROR: BT_LOCATION_MAP is empty — ensure bt-locations.js is loaded before bag-tool.js');
                } else {
                    this.setStatus('NOT FOUND', '"' + walkFromLabel + '" not in location map', 'error');
                    this.log('No walk entries found for: ' + walkFromLabel + ' (map has ' + mapSize + ' entries)');
                }
                return;
            }

            if (this.guidedState === 'WALKING') {
                if (this.walkIndex >= this.walkList.length) {
                    this.setStatus('DONE', 'Walk complete!', 'success');
                    this.playSound('success');
                    return;
                }

                const currentLoc = this.walkList[this.walkIndex];
                this.setStatus('LINKING', value.substring(0, 18) + '… → ' + currentLoc.label, 'pending');
                this.playSound('scan');

                this.linkBagAsync(
                    value,
                    currentLoc.scannableId,
                    (data) => {
                        this.addHistory(data.bagLabel, data.destinationLabel, false);
                        this.log('Guided link OK: ' + (data.bagLabel || value) + ' → ' + currentLoc.label);
                        // Stay on same location — user will scan next bag or tap SKIP
                        this.setStatus('SCAN BAG', currentLoc.label + ' ✓ last: ' + (data.bagLabel || value), 'ready');
                        this.updateGuidedDetail(currentLoc.label, (this.walkIndex + 1) + '/' + this.walkList.length);
                    },
                    (errCode) => {
                        this.setStatus('LINK ERROR', errCode + ' | stay on: ' + currentLoc.label, 'error');
                    }
                );
            }
        }

        // ==========================================
        //  GUIDED MODE — ADVANCE / SKIP
        // ==========================================

        guidedSkipLocation() {
            if (this.guidedState !== 'WALKING') return;
            this.log('Skipped: ' + (this.walkList[this.walkIndex] || {}).label);

            this.walkIndex++;
            if (this.walkIndex >= this.walkList.length) {
                this.setStatus('DONE', 'Walk complete!', 'success');
                this.playSound('success');
                this.guidedState = 'SCAN_START';
                this.updateGuidedSkipBtn(false);
                if (this.el.guidedLocation) this.el.guidedLocation.textContent = '—';
                if (this.el.guidedProgress) this.el.guidedProgress.textContent = '';
            } else {
                this.updateGuidedUI();
            }
        }

        updateGuidedUI(extraMsg) {
            if (this.walkIndex >= this.walkList.length) return;

            const current  = this.walkList[this.walkIndex];
            const next     = this.walkList[this.walkIndex + 1];
            const progress = (this.walkIndex + 1) + '/' + this.walkList.length;
            const nextHint = next ? ' → next: ' + next.label : ' (last)';

            this.setStatus('SCAN BAG', current.label + nextHint + (extraMsg ? ' | ' + extraMsg : ''), 'ready');
            this.updateGuidedDetail(current.label, progress);
            this.updateGuidedSkipBtn(true);
        }

        updateGuidedDetail(locationLabel, progress) {
            if (this.el.guidedLocation) this.el.guidedLocation.textContent = locationLabel;
            if (this.el.guidedProgress) this.el.guidedProgress.textContent = progress;
        }

        updateGuidedSkipBtn(visible) {
            if (this.el.skipBtn) this.el.skipBtn.style.display = visible ? 'inline-block' : 'none';
        }

        // ==========================================
        //  STYLES
        // ==========================================

        injectStyles() {
            const style = document.createElement('style');
            style.id    = 'bt-styles';
            style.textContent = `
                #bt-bar {
                    position: fixed; top: 0; left: 0; right: 0;
                    z-index: 2147483647;
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                    transition: background 0.2s;
                    user-select: none;
                    -webkit-tap-highlight-color: transparent;
                }
                #bt-bar.bt-idle    { background: #232f3e; }
                #bt-bar.bt-ready   { background: #0d47a1; }
                #bt-bar.bt-pending { background: #e65100; }
                #bt-bar.bt-success { background: #1b5e20; }
                #bt-bar.bt-error   { background: #b71c1c; }

                #bt-main {
                    display: flex; align-items: center;
                    justify-content: space-between;
                    padding: 8px 12px;
                }
                #bt-state {
                    font-size: 11px; font-weight: 800;
                    color: rgba(255,255,255,0.9);
                    letter-spacing: 1px; text-transform: uppercase;
                    white-space: nowrap;
                }
                #bt-msg {
                    font-size: 12px; color: rgba(255,255,255,0.75);
                    flex: 1; margin: 0 8px;
                    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
                }
                #bt-controls {
                    display: flex; align-items: center; gap: 6px; flex-shrink: 0;
                }
                .bt-btn {
                    padding: 4px 9px; border: none; border-radius: 4px;
                    font-size: 10px; font-weight: 800; cursor: pointer; flex-shrink: 0;
                }
                #bt-mode               { background: #ff4444; color: #fff; }
                #bt-mode.on            { background: #00e676; color: #000; }
                #bt-guided-toggle      { background: #7c4dff; color: #fff; }
                #bt-guided-toggle.on   { background: #ffd740; color: #000; }
                #bt-skip-btn {
                    display: none;
                    background: rgba(255,255,255,0.2);
                    color: #fff;
                    border: 1px solid rgba(255,255,255,0.45);
                    padding: 4px 12px; border-radius: 4px;
                    font-size: 11px; font-weight: 700; cursor: pointer;
                }
                #bt-skip-btn:active { opacity: 0.65; }

                #bt-token-dot {
                    width: 6px; height: 6px; border-radius: 50%;
                    background: #ff4444; flex-shrink: 0; transition: background 0.3s;
                }
                #bt-token-dot.bt-live { background: #00e676; }

                /* Guided panel */
                #bt-guided-panel {
                    display: none;
                    padding: 4px 12px 6px;
                    border-top: 1px solid rgba(255,255,255,0.1);
                }
                #bt-guided-panel.bt-show { display: block; }
                #bt-guided-location {
                    font-size: 34px; font-weight: 900;
                    color: #ffd740; letter-spacing: 2px; text-align: center;
                }
                #bt-guided-meta {
                    display: flex; justify-content: space-between;
                    font-size: 10px; color: rgba(255,255,255,0.45);
                    margin-top: 2px;
                }
                #bt-tier-row {
                    display: none; align-items: center; gap: 8px;
                    justify-content: center; padding: 3px 12px;
                    font-size: 10px; color: rgba(255,255,255,0.55);
                }
                #bt-tier-row label { cursor: pointer; }

                #bt-detail {
                    display: none; padding: 0 12px 8px;
                    font-size: 28px; font-weight: 900; color: #fff;
                    text-align: center; letter-spacing: 1px;
                }
                #bt-detail.bt-show { display: block; }

                #bt-history-toggle {
                    display: block; width: 100%; background: none; border: none;
                    border-top: 1px solid rgba(255,255,255,0.1);
                    color: rgba(255,255,255,0.3); font-size: 10px; padding: 4px;
                    cursor: pointer; text-align: center;
                }
                #bt-history-panel {
                    display: none; max-height: 150px; overflow-y: auto;
                    padding: 4px 12px 8px;
                }
                #bt-history-panel.bt-show { display: block; }
                .bt-hist-row {
                    display: flex; justify-content: space-between;
                    padding: 3px 0; font-size: 11px;
                    border-bottom: 1px solid rgba(255,255,255,0.05);
                }
                .bt-hist-bag  { color: rgba(255,255,255,0.5); font-family: monospace; }
                .bt-hist-dest { color: #69f0ae; font-weight: 700; }
                .bt-hist-dest.bt-err { color: #ff8a80; }

                #bt-debug {
                    display: none; padding: 4px 12px 8px;
                    font-family: monospace; font-size: 9px; color: #0f0;
                    background: rgba(0,0,0,0.3);
                    max-height: 100px; overflow-y: auto;
                    white-space: pre-wrap; word-break: break-all;
                }
                #bt-debug.bt-show { display: block; }
                .bt-ver { font-size: 8px; color: rgba(255,255,255,0.15); text-align: center; padding: 2px; }
            `;
            document.head.appendChild(style);
        }

        // ==========================================
        //  BUILD UI
        // ==========================================

        buildUI() {
            const bar = document.createElement('div');
            bar.id = 'bt-bar'; bar.className = 'bt-idle';
            bar.innerHTML = `
                <div id="bt-main">
                    <span id="bt-state">BAG TOOL</span>
                    <span id="bt-msg">Passthrough — use Dolphin to get token</span>
                    <div id="bt-controls">
                        <button id="bt-skip-btn" class="bt-btn">SKIP LOC</button>
                        <button id="bt-guided-toggle" class="bt-btn">GUIDED</button>
                        <button id="bt-mode" class="bt-btn">OFF</button>
                        <div id="bt-token-dot"></div>
                    </div>
                </div>
                <div id="bt-guided-panel">
                    <div id="bt-guided-location">—</div>
                    <div id="bt-guided-meta">
                        <span id="bt-guided-hint">Scan start location</span>
                        <span id="bt-guided-progress"></span>
                    </div>
                </div>
                <div id="bt-tier-row">
                    <input type="checkbox" id="bt-tier-cb" />
                    <label for="bt-tier-cb">Skip 4th tier (top shelf)</label>
                </div>
                <div id="bt-detail"></div>
                <button id="bt-history-toggle">history</button>
                <div id="bt-history-panel"></div>
                <div id="bt-debug"></div>
                <button id="bt-copy" style="display:block;width:100%;background:none;border:none;border-top:1px solid rgba(255,255,255,0.1);color:rgba(255,255,255,0.3);font-size:10px;padding:4px;cursor:pointer;text-align:center;">COPY LOG</button>
                <div class="bt-ver">v${BT_VERSION} | map: ${Object.keys(LOCATION_MAP).length} locs</div>
            `;
            document.body.appendChild(bar);

            this.el.bar            = bar;
            this.el.state          = document.getElementById('bt-state');
            this.el.msg            = document.getElementById('bt-msg');
            this.el.detail         = document.getElementById('bt-detail');
            this.el.tokenDot       = document.getElementById('bt-token-dot');
            this.el.historyToggle  = document.getElementById('bt-history-toggle');
            this.el.historyPanel   = document.getElementById('bt-history-panel');
            this.el.debug          = document.getElementById('bt-debug');
            this.el.modeBtn        = document.getElementById('bt-mode');
            this.el.guidedToggle   = document.getElementById('bt-guided-toggle');
            this.el.guidedPanel    = document.getElementById('bt-guided-panel');
            this.el.guidedLocation = document.getElementById('bt-guided-location');
            this.el.guidedProgress = document.getElementById('bt-guided-progress');
            this.el.guidedHint     = document.getElementById('bt-guided-hint');
            this.el.tierRow        = document.getElementById('bt-tier-row');
            this.el.tierCb         = document.getElementById('bt-tier-cb');
            this.el.skipBtn        = document.getElementById('bt-skip-btn');
            this.el.copyBtn        = document.getElementById('bt-copy');

            this.el.modeBtn.addEventListener('click',       e => { e.stopPropagation(); this.toggleMode(); });
            this.el.guidedToggle.addEventListener('click',  e => { e.stopPropagation(); this.toggleGuidedMode(); });
            this.el.skipBtn.addEventListener('click',       e => { e.stopPropagation(); this.guidedSkipLocation(); });
            this.el.historyToggle.addEventListener('click', e => { e.stopPropagation(); this.el.historyPanel.classList.toggle('bt-show'); });
            this.el.copyBtn.addEventListener('click',       e => { e.stopPropagation(); this.copyHistory(); });

            this.el.tierCb.addEventListener('change', () => {
                this.skip4thTier = this.el.tierCb.checked;
                this.log('Skip 4th tier: ' + this.skip4thTier);
                if (this.guidedState === 'WALKING' && this.startLabel) {
                    const prevLabel = (this.walkList[this.walkIndex] || {}).label;
                    this.walkList   = buildWalkList(this.startLabel, this.skip4thTier);
                    // Try to resume at same label after rebuild
                    const newIdx = this.walkList.findIndex(w => w.label === prevLabel);
                    this.walkIndex = newIdx >= 0 ? newIdx : 0;
                    this.updateGuidedUI();
                }
            });

            // Long-press debug
            let pt;
            bar.addEventListener('touchstart', () => { pt = setTimeout(() => this.el.debug.classList.toggle('bt-show'), 800); }, { passive: true });
            bar.addEventListener('touchend',   () => clearTimeout(pt), { passive: true });
        }

        // ==========================================
        //  MODE TOGGLES
        // ==========================================

        toggleMode() {
            this.intercepting = !this.intercepting;
            this.el.modeBtn.textContent = this.intercepting ? 'ON' : 'OFF';
            this.el.modeBtn.classList.toggle('on', this.intercepting);

            if (this.intercepting) {
                if (this.mode === 'guided') {
                    this.guidedState = 'SCAN_START';
                    this.el.guidedPanel.classList.add('bt-show');
                    this.el.guidedLocation.textContent = '?';
                    this.el.guidedHint.textContent     = 'Scan start location';
                    this.el.guidedProgress.textContent = '';
                    this.updateGuidedSkipBtn(false);
                    this.setStatus('GUIDED', 'Scan your START location  e.g. H-40', 'pending');
                } else {
                    this.setStatus('SCAN BAG', 'Ready', 'idle');
                }
            } else {
                this.setStatus('PASSTHROUGH', 'Scans go to Dolphin', 'pending');
                this.state      = 'READY';
                this.currentBag = null;
                this.guidedState = 'SCAN_START';
                this.el.guidedPanel.classList.remove('bt-show');
                this.updateGuidedSkipBtn(false);
            }
            this.log('Intercepting: ' + this.intercepting);
        }

        toggleGuidedMode() {
            if (this.mode === 'standard') {
                this.mode = 'guided';
                this.el.guidedToggle.textContent = 'STANDARD';
                this.el.guidedToggle.classList.add('on');
                this.el.tierRow.style.display = 'flex';
                this.guidedState = 'SCAN_START';
                this.log('Switched → GUIDED');
                if (this.intercepting) {
                    this.el.guidedPanel.classList.add('bt-show');
                    this.el.guidedLocation.textContent = '?';
                    this.el.guidedHint.textContent     = 'Scan start location';
                    this.el.guidedProgress.textContent = '';
                    this.updateGuidedSkipBtn(false);
                    this.setStatus('GUIDED', 'Scan your START location  e.g. H-40', 'pending');
                }
            } else {
                this.mode = 'standard';
                this.el.guidedToggle.textContent = 'GUIDED';
                this.el.guidedToggle.classList.remove('on');
                this.el.tierRow.style.display = 'none';
                this.el.guidedPanel.classList.remove('bt-show');
                this.updateGuidedSkipBtn(false);
                this.state = 'READY';
                this.log('Switched → STANDARD');
                if (this.intercepting) this.setStatus('SCAN BAG', 'Ready', 'idle');
            }
        }

        // ==========================================
        //  UI HELPERS
        // ==========================================

        setStatus(stateText, message, type) {
            this.el.state.textContent = stateText;
            this.el.msg.textContent   = message;
            this.el.bar.className     = 'bt-' + type;
            if ((type === 'success' || type === 'ready') && this.mode === 'standard') {
                const detail = message.includes('→') ? message.split('→').pop().trim() : '';
                if (detail) { this.el.detail.textContent = detail; this.el.detail.classList.add('bt-show'); }
                else          this.el.detail.classList.remove('bt-show');
            } else {
                this.el.detail.classList.remove('bt-show');
            }
        }

        updateTokenDot() {
            if (this.el.tokenDot) this.el.tokenDot.classList.toggle('bt-live', !!this.token);
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
            const lines  = this.history.map(h => h.bag + ' → ' + h.dest + (h.isError ? ' [ERROR]' : '')).join('\n');
            const debug  = this.el.debug ? this.el.debug.textContent : '';
            const output = '=== BAG HISTORY ===\n' + (lines || '(empty)') + '\n\n=== DEBUG LOG ===\n' + debug;
            navigator.clipboard.writeText(output).then(() => {
                this.el.copyBtn.textContent = 'COPIED';
                setTimeout(() => { this.el.copyBtn.textContent = 'COPY LOG'; }, 1500);
            }).catch(() => {
                const ta = document.createElement('textarea');
                ta.value = output; document.body.appendChild(ta); ta.select();
                document.execCommand('copy'); ta.remove();
                this.el.copyBtn.textContent = 'COPIED';
                setTimeout(() => { this.el.copyBtn.textContent = 'COPY LOG'; }, 1500);
            });
        }

        playSound(type) {
            try {
                const ctx  = new (window.AudioContext || window.webkitAudioContext)();
                const osc  = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.connect(gain); gain.connect(ctx.destination);
                if (type === 'success') {
                    osc.frequency.value = 880; gain.gain.value = 0.3; osc.start();
                    osc.frequency.setValueAtTime(1108, ctx.currentTime + 0.1);
                    gain.gain.setValueAtTime(0, ctx.currentTime + 0.2);
                    osc.stop(ctx.currentTime + 0.2);
                } else if (type === 'error') {
                    osc.frequency.value = 300; gain.gain.value = 0.4; osc.start();
                    osc.frequency.setValueAtTime(200, ctx.currentTime + 0.15);
                    gain.gain.setValueAtTime(0, ctx.currentTime + 0.4);
                    osc.stop(ctx.currentTime + 0.4);
                } else if (type === 'scan') {
                    osc.frequency.value = 1200; gain.gain.value = 0.15; osc.start();
                    gain.gain.setValueAtTime(0, ctx.currentTime + 0.05);
                    osc.stop(ctx.currentTime + 0.05);
                }
            } catch (e) { /* no audio */ }
        }

        log(msg) {
            const entry = '[' + new Date().toLocaleTimeString() + '] ' + msg;
            console.log('[BT] ' + entry);
            if (this.el.debug) {
                this.el.debug.textContent = entry + '\n' + this.el.debug.textContent;
                const lines = this.el.debug.textContent.split('\n');
                if (lines.length > 30) this.el.debug.textContent = lines.slice(0, 30).join('\n');
            }
        }
    }

    window.__bagTool = new BagTool();
})();
