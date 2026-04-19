(function () {
    'use strict';

    const BT_VERSION = '2.00';

    if (window.__bagTool) return;

    // ==========================================
    //  GUIDED MODE — LOCATION WALK LOGIC
    // ==========================================

    /**
     * Given a start location label like "H-40" and a locationMap of
     * { displayLabel -> scannableId }, generate an ordered walk list.
     *
     * Aisle layout per your spec:
     *   Each position is: <clusterPrefix>-<bayNum>.<tier><suffix>
     *   e.g. H-40.1A, H-40.1B ... H-40.1G, H-40.2A ... H-40.4G
     *   Tiers: 1, 2, 3, 4  (4th tier is optional/skippable)
     *   Suffixes: A B C D E F G
     *
     * Walk order (per your description):
     *   - Group by (bayNum, suffix) pairs cycling suffix A→G
     *   - Within each suffix, descend bay numbers from start down to 1
     *   - Pattern: all rows of suffix A descending, then all of B descending, etc.
     *   - Within each (bayNum, suffix): tier 1 then 2 then 3 (then 4 if not skipped)
     */

    const AISLE_SUFFIXES = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
    const AISLE_TIERS    = [1, 2, 3, 4];

    function parseLocationLabel(label) {
        // e.g. "H-40" or "DMD6-H-40" or "H-40.2C"
        // Returns { prefix, bay, tier, suffix } — tier/suffix null if it's a bay-level label
        const m = label.match(/^(.*?)-(\d+)(?:\.(\d)([A-Ga-g]))?$/);
        if (!m) return null;
        return {
            prefix: m[1],
            bay: parseInt(m[2], 10),
            tier: m[3] ? parseInt(m[3], 10) : null,
            suffix: m[4] ? m[4].toUpperCase() : null,
        };
    }

    function buildWalkList(startLabel, locationMap, skip4thTier) {
        const parsed = parseLocationLabel(startLabel);
        if (!parsed) return [];

        const { prefix, bay: startBay } = parsed;
        const tiers = skip4thTier ? AISLE_TIERS.slice(0, 3) : AISLE_TIERS;

        const walkList = [];

        // Walk order: suffix A → G, within each suffix descend bays from startBay → 1
        for (const suffix of AISLE_SUFFIXES) {
            for (let bay = startBay; bay >= 1; bay--) {
                for (const tier of tiers) {
                    const label = `${prefix}-${bay}.${tier}${suffix}`;
                    const scannableId = locationMap[label];
                    if (scannableId) {
                        walkList.push({ label, scannableId });
                    }
                }
            }
        }

        return walkList;
    }

    // ==========================================
    //  MAIN CLASS
    // ==========================================

    class BagTool {
        constructor() {
            this.token          = null;
            this.tokenTimestamp = null;

            // mode: 'standard' | 'guided'
            this.mode           = 'standard';

            // standard mode state
            this.state          = 'READY'; // READY | VALIDATING | AWAITING_LOCATION | LINKING
            this.currentBag     = null;

            // guided mode state
            this.guidedState    = 'SCAN_START'; // SCAN_START | WALKING
            this.locationMap    = {};           // displayLabel -> scannableId (preloaded)
            this.walkList       = [];           // ordered list of { label, scannableId }
            this.walkIndex      = 0;
            this.skip4thTier    = false;
            this.startLabel     = null;

            this.scanBuffer     = '';
            this.scanTimeout    = null;
            this.lastKeystroke  = 0;
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
            this.log('Initialized v' + BT_VERSION + ' — passthrough mode');
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
                if (e.key === 'Enter' || e.keyCode === 13) {
                    if (!self.intercepting) return;
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
            this.log('Scanner listener attached');
        }

        // ==========================================
        //  SCAN ROUTING
        // ==========================================

        async processScan(value) {
            value = value.trim();
            this.log('Scanned: ' + value);

            if (this.mode === 'guided') {
                await this.processGuidedScan(value);
            } else {
                // standard mode
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
                        'Accept':           'application/json, text/plain, */*',
                        'Content-Type':     'application/json;charset=utf-8',
                        'x-amz-access-token': this.token,
                    },
                    body: JSON.stringify({ bagScannableId: bagId, scope: 'AMZL' }),
                });

                if (!res.ok) {
                    const body = await res.text();
                    throw new Error('HTTP ' + res.status + ' | ' + body.substring(0, 200));
                }
                const data = await res.json();

                if (data.responseCode === 'SUCCESS') {
                    const existing = data.existingDestinationLabel;
                    this.state = 'AWAITING_LOCATION';
                    this.setStatus('SCAN LOCATION',
                        bagId + (existing ? ' -> currently: ' + existing : ' (no current destination)'),
                        'ready');
                    this.playSound('scan');
                    this.log('Bag valid: ' + bagId + (existing ? ' at ' + existing : ' unlinked'));
                } else {
                    this.state = 'READY';
                    this.setStatus('BAG ERROR', data.responseCode || 'Unknown error', 'error');
                    this.playSound('error');
                }
            } catch (err) {
                this.state = 'READY';
                this.setStatus('ERROR', err.message, 'error');
                this.playSound('error');
            }
        }

        async handleLocationScan(locationId) {
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

            const bag       = this.currentBag;
            this.currentBag = null;
            this.state      = 'READY';

            this.setStatus('LINKING...', bag + ' -> ' + locationId, 'pending');
            this.playSound('scan');
            this.linkBagAsync(bag, locationId);
        }

        linkBagAsync(bag, locationId, onSuccess, onError) {
            fetch('https://dolphin.amazon.com/nss/open/bag', {
                method:  'POST',
                headers: {
                    'Accept':             'application/json, text/plain, */*',
                    'Content-Type':       'application/json;charset=utf-8',
                    'x-amz-access-token': this.token,
                },
                body: JSON.stringify({
                    bagScannableId:          bag,
                    destinationScannableId:  locationId,
                    scope:                   'AMZL',
                }),
            })
            .then(async (res) => {
                if (!res.ok) {
                    const body = await res.text();
                    throw new Error('HTTP ' + res.status + ' | ' + body.substring(0, 200));
                }
                return res.json();
            })
            .then((data) => {
                if (data.responseCode === 'SUCCESS') {
                    this.addHistory(data.bagLabel, data.destinationLabel, false);
                    this.playSound('success');
                    this.log('Linked: ' + data.bagLabel + ' -> ' + data.destinationLabel);
                    if (onSuccess) onSuccess(data);
                    else if (this.state === 'READY' && !this.currentBag) {
                        this.setStatus('SCAN BAG', 'Last: ' + data.bagLabel + ' -> ' + data.destinationLabel, 'success');
                        setTimeout(() => {
                            if (this.state === 'READY' && !this.currentBag) {
                                this.setStatus('SCAN BAG', 'Ready', 'idle');
                            }
                        }, 2000);
                    }
                } else {
                    this.addHistory(bag, data.responseCode || 'ERROR', true);
                    this.playSound('error');
                    if (onError) onError(data.responseCode);
                    else if (this.state === 'READY' && !this.currentBag) {
                        this.setStatus('LINK ERROR', data.responseCode || 'Unknown', 'error');
                    }
                }
            })
            .catch((err) => {
                this.addHistory(bag, 'ERR', true);
                this.playSound('error');
                if (onError) onError(err.message);
                else if (this.state === 'READY' && !this.currentBag) {
                    this.setStatus('ERROR', err.message, 'error');
                }
            });
        }

        // ==========================================
        //  GUIDED MODE — LOCATION PRELOAD
        // ==========================================

        async preloadLocations() {
            if (!this.token) {
                this.log('No token — cannot preload locations via API');
                return false;
            }
            try {
                this.setStatus('LOADING LOCATIONS', 'Fetching from SCC...', 'pending');
                // Try the Dolphin resource endpoint — same pattern as bag-reset-dashboard uses
                // via the coral gateway / coralgateway approach
                const res = await fetch('https://dolphin.amazon.com/nss/open/resources', {
                    method:  'POST',
                    headers: {
                        'Accept':             'application/json, text/plain, */*',
                        'Content-Type':       'application/json;charset=utf-8',
                        'x-amz-access-token': this.token,
                    },
                    body: JSON.stringify({ scope: 'AMZL' }),
                });

                if (!res.ok) throw new Error('HTTP ' + res.status);
                const data = await res.json();

                // Expect data to have a list of locations with label + scannableId
                const locations = data.locations || data.resources || data.nodeResources || [];
                let count = 0;
                for (const loc of locations) {
                    const label      = loc.label || loc.displayLabel || loc.name;
                    const scannable  = loc.scannableId || loc.scannable;
                    if (label && scannable) {
                        this.locationMap[label]    = scannable;
                        this.locationMap[scannable] = scannable; // also index by scannable
                        count++;
                    }
                }
                this.log('Preloaded ' + count + ' locations from API');
                return count > 0;
            } catch (err) {
                this.log('API preload failed: ' + err.message + ' — will resolve by scan');
                return false;
            }
        }

        /**
         * Register a location: label -> scannableId
         * Called when user scans a location label in SCAN_START state.
         * If not in locationMap, we fall back to treating the scanned value
         * as the scannableId directly (the scanner reads the barcode = scannableId).
         */
        resolveLocation(scannedValue) {
            // If the scanned value is already in the map (label was scanned), return its scannableId
            if (this.locationMap[scannedValue]) {
                return { scannableId: this.locationMap[scannedValue], label: scannedValue };
            }
            // Check if scannedValue IS a scannableId (UUID-like)
            if (/^[0-9a-f-]{30,}$/i.test(scannedValue)) {
                // It's a raw scannableId — find the label if we can
                const label = Object.keys(this.locationMap).find(k =>
                    this.locationMap[k] === scannedValue && !/^[0-9a-f-]{30,}$/i.test(k)
                ) || scannedValue;
                return { scannableId: scannedValue, label };
            }
            // Unknown format — use as-is (scannableId = scannedValue)
            return { scannableId: scannedValue, label: scannedValue };
        }

        // ==========================================
        //  GUIDED MODE — SCAN PROCESSING
        // ==========================================

        async processGuidedScan(value) {
            if (this.guidedState === 'SCAN_START') {
                // First scan in guided mode = the starting location
                const loc = this.resolveLocation(value);
                this.startLabel = loc.label;

                this.walkList  = buildWalkList(loc.label, this.locationMap, this.skip4thTier);
                this.walkIndex = 0;

                if (this.walkList.length === 0) {
                    // No preloaded map — generate theoretical walk from label structure
                    this.walkList  = this.generateTheoreticalWalk(loc.label);
                    this.walkIndex = 0;
                }

                if (this.walkList.length > 0) {
                    this.guidedState = 'WALKING';
                    this.log('Guided walk started from ' + loc.label + ' — ' + this.walkList.length + ' locations');
                    this.updateGuidedUI();
                } else {
                    this.setStatus('GUIDED ERROR', 'Could not build walk from: ' + loc.label, 'error');
                    this.playSound('error');
                }
                return;
            }

            if (this.guidedState === 'WALKING') {
                // A bag was scanned — link it to current location
                if (this.walkIndex >= this.walkList.length) {
                    this.setStatus('GUIDED DONE', 'Walk complete! All locations visited.', 'success');
                    this.playSound('success');
                    return;
                }

                const currentLoc = this.walkList[this.walkIndex];
                const bag        = value;

                this.setStatus('LINKING', bag + ' → ' + currentLoc.label, 'pending');
                this.playSound('scan');

                this.linkBagAsync(
                    bag,
                    currentLoc.scannableId,
                    (data) => {
                        // Success — stay on same location (more bags may go here)
                        this.addHistory(data.bagLabel, data.destinationLabel, false);
                        this.log('Guided link: ' + bag + ' -> ' + currentLoc.label);
                        this.updateGuidedUI('Last: ' + (data.bagLabel || bag));
                    },
                    (errCode) => {
                        this.setStatus('LINK ERROR', errCode + ' | ' + currentLoc.label, 'error');
                    }
                );
            }
        }

        /**
         * Generate a theoretical walk when we have no preloaded map.
         * Creates location entries using the label as the scannableId placeholder.
         * The user physically scans the location to advance.
         */
        generateTheoreticalWalk(startLabel) {
            const parsed = parseLocationLabel(startLabel);
            if (!parsed) return [];

            const { prefix, bay: startBay } = parsed;
            const tiers  = this.skip4thTier ? AISLE_TIERS.slice(0, 3) : AISLE_TIERS;
            const result = [];

            for (const suffix of AISLE_SUFFIXES) {
                for (let bay = startBay; bay >= 1; bay--) {
                    for (const tier of tiers) {
                        const label = `${prefix}-${bay}.${tier}${suffix}`;
                        result.push({ label, scannableId: label }); // placeholder
                    }
                }
            }
            return result;
        }

        // ==========================================
        //  GUIDED MODE — ADVANCE / SKIP
        // ==========================================

        guidedAdvance() {
            if (this.walkIndex < this.walkList.length - 1) {
                this.walkIndex++;
                this.updateGuidedUI();
            } else {
                this.setStatus('GUIDED DONE', 'Walk complete!', 'success');
                this.playSound('success');
                this.guidedState = 'SCAN_START';
                this.updateGuidedSkipBtn(false);
            }
        }

        guidedSkipLocation() {
            this.log('Skipped: ' + (this.walkList[this.walkIndex] || {}).label);
            this.guidedAdvance();
        }

        updateGuidedUI(extraMsg) {
            if (this.walkIndex >= this.walkList.length) return;

            const current  = this.walkList[this.walkIndex];
            const next     = this.walkList[this.walkIndex + 1];
            const progress = (this.walkIndex + 1) + '/' + this.walkList.length;

            const msg = current.label + (next ? '  →next: ' + next.label : '  (last)');
            this.setStatus('SCAN BAG', msg + (extraMsg ? ' | ' + extraMsg : ''), 'ready');
            this.updateGuidedDetail(current.label, progress);
            this.updateGuidedSkipBtn(true);
        }

        updateGuidedDetail(locationLabel, progress) {
            if (this.el.guidedLocation) {
                this.el.guidedLocation.textContent = locationLabel;
            }
            if (this.el.guidedProgress) {
                this.el.guidedProgress.textContent = progress;
            }
        }

        updateGuidedSkipBtn(visible) {
            if (this.el.skipBtn) {
                this.el.skipBtn.style.display = visible ? 'inline-block' : 'none';
            }
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
                #bt-bar.bt-idle    { background: #232f3e; }
                #bt-bar.bt-ready   { background: #0d47a1; }
                #bt-bar.bt-pending { background: #e65100; }
                #bt-bar.bt-success { background: #1b5e20; }
                #bt-bar.bt-error   { background: #b71c1c; }

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
                    text-align: left;
                    flex: 1;
                    margin: 0 8px;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                }
                #bt-controls {
                    display: flex;
                    align-items: center;
                    gap: 6px;
                    flex-shrink: 0;
                }
                .bt-btn {
                    padding: 3px 8px;
                    border: none;
                    border-radius: 4px;
                    font-size: 10px;
                    font-weight: 800;
                    cursor: pointer;
                    flex-shrink: 0;
                }
                #bt-mode {
                    background: #ff4444;
                    color: #fff;
                }
                #bt-mode.on {
                    background: #00e676;
                    color: #000;
                }
                #bt-guided-toggle {
                    background: #7c4dff;
                    color: #fff;
                }
                #bt-guided-toggle.on {
                    background: #ffd740;
                    color: #000;
                }
                #bt-skip-btn {
                    display: none;
                    background: rgba(255,255,255,0.25);
                    color: #fff;
                    border: 1px solid rgba(255,255,255,0.5);
                    padding: 3px 10px;
                    border-radius: 4px;
                    font-size: 11px;
                    font-weight: 700;
                    cursor: pointer;
                }
                #bt-skip-btn:active { opacity: 0.7; }

                #bt-token-dot {
                    width: 6px; height: 6px;
                    border-radius: 50%;
                    background: #ff4444;
                    flex-shrink: 0;
                    transition: background 0.3s;
                }
                #bt-token-dot.bt-live { background: #00e676; }

                /* Guided location display */
                #bt-guided-panel {
                    display: none;
                    padding: 4px 12px 6px;
                    border-top: 1px solid rgba(255,255,255,0.1);
                }
                #bt-guided-panel.bt-show { display: block; }
                #bt-guided-location {
                    font-size: 32px;
                    font-weight: 900;
                    color: #ffd740;
                    letter-spacing: 1px;
                    text-align: center;
                }
                #bt-guided-meta {
                    display: flex;
                    justify-content: space-between;
                    font-size: 10px;
                    color: rgba(255,255,255,0.5);
                    margin-top: 2px;
                }
                #bt-guided-tier-toggle {
                    display: flex;
                    align-items: center;
                    gap: 6px;
                    justify-content: center;
                    padding: 4px 12px;
                    font-size: 10px;
                    color: rgba(255,255,255,0.6);
                }
                #bt-tier-checkbox {
                    cursor: pointer;
                }

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
                .bt-hist-bag  { color: rgba(255,255,255,0.5); font-family: monospace; }
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
            bar.id        = 'bt-bar';
            bar.className = 'bt-idle';
            bar.innerHTML = `
                <div id="bt-main">
                    <span id="bt-state">SCAN BAG</span>
                    <span id="bt-msg">Passthrough — use Dolphin to get token</span>
                    <div id="bt-controls">
                        <button id="bt-skip-btn" class="bt-btn">SKIP LOC</button>
                        <button id="bt-guided-toggle" class="bt-btn">GUIDED</button>
                        <button id="bt-mode" class="bt-btn">OFF</button>
                        <div id="bt-token-dot"></div>
                    </div>
                </div>

                <!-- Guided mode panel -->
                <div id="bt-guided-panel">
                    <div id="bt-guided-location">—</div>
                    <div id="bt-guided-meta">
                        <span id="bt-guided-scan-hint">Scan bag for this location</span>
                        <span id="bt-guided-progress"></span>
                    </div>
                </div>

                <!-- 4th tier toggle (shown in guided mode) -->
                <div id="bt-guided-tier-toggle" style="display:none">
                    <input type="checkbox" id="bt-tier-checkbox" />
                    <label for="bt-tier-checkbox">Skip 4th tier (top shelf)</label>
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

            this.el.bar           = bar;
            this.el.state         = document.getElementById('bt-state');
            this.el.msg           = document.getElementById('bt-msg');
            this.el.detail        = document.getElementById('bt-detail');
            this.el.tokenDot      = document.getElementById('bt-token-dot');
            this.el.historyToggle = document.getElementById('bt-history-toggle');
            this.el.historyPanel  = document.getElementById('bt-history-panel');
            this.el.debug         = document.getElementById('bt-debug');
            this.el.modeBtn       = document.getElementById('bt-mode');
            this.el.guidedToggle  = document.getElementById('bt-guided-toggle');
            this.el.guidedPanel   = document.getElementById('bt-guided-panel');
            this.el.guidedLocation= document.getElementById('bt-guided-location');
            this.el.guidedProgress= document.getElementById('bt-guided-progress');
            this.el.guidedHint    = document.getElementById('bt-guided-scan-hint');
            this.el.tierToggleRow = document.getElementById('bt-guided-tier-toggle');
            this.el.tierCheckbox  = document.getElementById('bt-tier-checkbox');
            this.el.skipBtn       = document.getElementById('bt-skip-btn');
            this.el.copyBtn       = document.getElementById('bt-copy');

            // ON/OFF toggle
            this.el.modeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.toggleMode();
            });

            // GUIDED mode toggle
            this.el.guidedToggle.addEventListener('click', (e) => {
                e.stopPropagation();
                this.toggleGuidedMode();
            });

            // Skip location button
            this.el.skipBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.guidedSkipLocation();
            });

            // 4th tier toggle
            this.el.tierCheckbox.addEventListener('change', () => {
                this.skip4thTier = this.el.tierCheckbox.checked;
                this.log('Skip 4th tier: ' + this.skip4thTier);
                // Rebuild walk if already walking
                if (this.guidedState === 'WALKING' && this.startLabel) {
                    this.walkList  = buildWalkList(this.startLabel, this.locationMap, this.skip4thTier);
                    if (this.walkList.length === 0) {
                        this.walkList = this.generateTheoreticalWalk(this.startLabel);
                    }
                    this.walkIndex = Math.min(this.walkIndex, this.walkList.length - 1);
                    this.updateGuidedUI();
                }
            });

            // Copy log
            this.el.copyBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.copyHistory();
            });

            // History toggle
            this.el.historyToggle.addEventListener('click', (e) => {
                e.stopPropagation();
                this.el.historyPanel.classList.toggle('bt-show');
            });

            // Long-press debug
            let pressTimer;
            bar.addEventListener('touchstart', () => {
                pressTimer = setTimeout(() => {
                    this.el.debug.classList.toggle('bt-show');
                }, 800);
            }, { passive: true });
            bar.addEventListener('touchend', () => clearTimeout(pressTimer), { passive: true });
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
                    this.setStatus('GUIDED', 'Scan your START location (e.g. H-40)', 'pending');
                    this.guidedState = 'SCAN_START';
                    this.el.guidedPanel.classList.add('bt-show');
                    this.el.guidedLocation.textContent = '?';
                    this.el.guidedHint.textContent = 'Scan start location';
                    this.el.guidedProgress.textContent = '';
                    // Attempt location preload in background
                    this.preloadLocations().then(ok => {
                        this.log('Location preload: ' + (ok ? 'success' : 'failed/no API'));
                    });
                } else {
                    this.setStatus('SCAN BAG', 'Ready', 'idle');
                }
            } else {
                this.setStatus('PASSTHROUGH', 'Scans go to Dolphin', 'pending');
                this.state       = 'READY';
                this.currentBag  = null;
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
                this.el.tierToggleRow.style.display = 'flex';
                this.guidedState = 'SCAN_START';
                this.log('Mode switched → GUIDED');
                if (this.intercepting) {
                    this.setStatus('GUIDED', 'Scan your START location (e.g. H-40)', 'pending');
                    this.el.guidedPanel.classList.add('bt-show');
                    this.el.guidedLocation.textContent = '?';
                    this.el.guidedHint.textContent     = 'Scan start location';
                    this.el.guidedProgress.textContent = '';
                    this.preloadLocations();
                }
            } else {
                this.mode = 'standard';
                this.el.guidedToggle.textContent = 'GUIDED';
                this.el.guidedToggle.classList.remove('on');
                this.el.tierToggleRow.style.display = 'none';
                this.el.guidedPanel.classList.remove('bt-show');
                this.updateGuidedSkipBtn(false);
                this.state = 'READY';
                this.log('Mode switched → STANDARD');
                if (this.intercepting) {
                    this.setStatus('SCAN BAG', 'Ready', 'idle');
                }
            }
        }

        // ==========================================
        //  UI UPDATES
        // ==========================================

        setStatus(stateText, message, type) {
            this.el.state.textContent = stateText;
            this.el.msg.textContent   = message;
            this.el.bar.className     = 'bt-' + type;

            if (type === 'success' || type === 'ready') {
                const detail = message.includes('->') ? message.split('->').pop().trim() : '';
                if (detail && this.mode === 'standard') {
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
            const lines     = this.history.map(h => h.bag + ' -> ' + h.dest + (h.isError ? ' [ERROR]' : '')).join('\n');
            const debugLines = this.el.debug ? this.el.debug.textContent : '';
            const output    = '=== BAG HISTORY ===\n' + (lines || '(empty)') + '\n\n=== DEBUG LOG ===\n' + debugLines;

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
        }

        playSound(type) {
            try {
                const ctx  = new (window.AudioContext || window.webkitAudioContext)();
                const osc  = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.connect(gain);
                gain.connect(ctx.destination);

                if (type === 'success') {
                    osc.frequency.value = 880;
                    gain.gain.value     = 0.3;
                    osc.start();
                    osc.frequency.setValueAtTime(1108, ctx.currentTime + 0.1);
                    gain.gain.setValueAtTime(0, ctx.currentTime + 0.2);
                    osc.stop(ctx.currentTime + 0.2);
                } else if (type === 'error') {
                    osc.frequency.value = 300;
                    gain.gain.value     = 0.4;
                    osc.start();
                    osc.frequency.setValueAtTime(200, ctx.currentTime + 0.15);
                    gain.gain.setValueAtTime(0, ctx.currentTime + 0.4);
                    osc.stop(ctx.currentTime + 0.4);
                } else if (type === 'scan') {
                    osc.frequency.value = 1200;
                    gain.gain.value     = 0.15;
                    osc.start();
                    gain.gain.setValueAtTime(0, ctx.currentTime + 0.05);
                    osc.stop(ctx.currentTime + 0.05);
                }
            } catch (e) { /* Audio not available */ }
        }

        log(msg) {
            const ts    = new Date().toLocaleTimeString();
            const entry = '[' + ts + '] ' + msg;
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
