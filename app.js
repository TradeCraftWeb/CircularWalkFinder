/**
 * Circular Walk Finder — app.js
 * ============================================================
 * Generates circular walking routes in the UK using:
 *  - postcodes.io for UK postcode → lat/lon geocoding
 *  - OpenRouteService (ORS) Directions API for route generation
 *  - Leaflet.js for interactive map rendering
 *
 * API Key: Sign up at https://openrouteservice.org to get a free key.
 *   Rate limits (free tier): ~40 req/min, 2,000 req/day.
 *   Insert your key in the input field at the top of the sidebar,
 *   or store it via the 💾 button to persist in localStorage.
 *
 * Attribution required:
 *   © OpenStreetMap contributors (ODbL)
 *   Routing by OpenRouteService / HeiGIT (CC-BY 4.0)
 *   Postcode data: postcodes.io (MIT)
 */

'use strict';

// ── Constants ─────────────────────────────────────────────────
const ORS_BASE = 'https://api.openrouteservice.org/v2';
const POSTCODE_API = 'https://api.postcodes.io/postcodes/';
const LS_KEY_APIKEY = 'cwf_ors_api_key';
const LS_KEY_THEME  = 'cwf_theme';

// ORS waytype IDs that count as "footpath-like"
// Ref: https://openrouteservice.org/dev/#/api-docs/v2/directions/{profile}/post
// waytype values: 0=unknown,1=state_road,2=road,3=street,4=path,5=track,
//                 6=cycleway,7=footway,8=steps,9=ferry,10=construction
const FOOTPATH_WAYTYPES = new Set([4, 5, 7, 8]); // path, track, footway, steps

// ORS surface IDs that are "natural/off-road"
// surface: 0=unknown,1=paved,2=unpaved,3=asphalt,4=concrete,5=cobblestone,
//          6=metal,7=wood,8=compacted_gravel,9=fine_gravel,10=gravel,
//          11=dirt,12=ground,13=ice,14=paving_stones,15=sand,16=woodchips,17=grass,18=grass_paver
const NATURAL_SURFACES = new Set([2, 8, 9, 10, 11, 12, 15, 16, 17]);

// Colour palette for routes on the map
const ROUTE_COLOURS = [
  '#22c55e', '#3b82f6', '#f59e0b', '#ec4899',
  '#8b5cf6', '#14b8a6', '#f97316', '#06b6d4'
];

// ── State ──────────────────────────────────────────────────────
let map = null;
let startMarker = null;
let routeLayers = [];  // Array of Leaflet polyline layers
let radiusCircle = null;
let routes = [];       // Generated route objects
let activeRouteIndex = -1;
let currentTheme = null; // 'light' | 'dark' | null (auto)

// ── DOM References ─────────────────────────────────────────────
const $ = id => document.getElementById(id);

// ── Theme ──────────────────────────────────────────────────────
function initTheme() {
  const stored = localStorage.getItem(LS_KEY_THEME);
  if (stored) applyTheme(stored);
  $('themeToggle').addEventListener('click', () => {
    const next = document.documentElement.classList.contains('theme-dark') ? 'light' : 'dark';
    applyTheme(next);
    localStorage.setItem(LS_KEY_THEME, next);
  });
}

function applyTheme(theme) {
  document.documentElement.classList.remove('theme-light', 'theme-dark');
  document.documentElement.classList.add(`theme-${theme}`);
  currentTheme = theme;
  $('themeToggle').textContent = theme === 'dark' ? '☀️' : '🌙';
}

// ── API Key Management ─────────────────────────────────────────
function initApiKey() {
  const stored = localStorage.getItem(LS_KEY_APIKEY);
  if (stored) $('apiKey').value = stored;

  $('saveApiKey').addEventListener('click', () => {
    const val = $('apiKey').value.trim();
    if (val) {
      localStorage.setItem(LS_KEY_APIKEY, val);
      showToast('API key saved to browser storage');
    } else {
      localStorage.removeItem(LS_KEY_APIKEY);
      showToast('API key cleared');
    }
  });

  $('toggleApiKey').addEventListener('click', () => {
    const inp = $('apiKey');
    if (inp.type === 'password') {
      inp.type = 'text';
      $('toggleApiKey').textContent = '🙈';
    } else {
      inp.type = 'password';
      $('toggleApiKey').textContent = '👁️';
    }
  });
}

// ── Map initialisation ─────────────────────────────────────────
function initMap() {
  map = L.map('map', {
    center: [54.5, -3.0], // UK centre
    zoom: 6,
    zoomControl: true,
    attributionControl: true
  });

  // OpenStreetMap tile layer
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19
  }).addTo(map);

  // Prevent map interaction from bubbling to the form
  map.on('click', () => {});
}

// ── Geocoding (postcodes.io) ───────────────────────────────────
/**
 * Resolves a UK postcode to { lat, lon, formatted } using postcodes.io.
 * Falls back to a simple ORS geocode if postcodes.io fails.
 * @param {string} postcode
 * @returns {Promise<{lat:number, lon:number, formatted:string}>}
 */
async function geocodePostcode(postcode) {
  const clean = postcode.replace(/\s+/g, '').toUpperCase();

  // Primary: postcodes.io
  try {
    const resp = await fetch(`${POSTCODE_API}${encodeURIComponent(clean)}`);
    if (resp.ok) {
      const data = await resp.json();
      if (data.status === 200 && data.result) {
        return {
          lat: data.result.latitude,
          lon: data.result.longitude,
          formatted: data.result.postcode
        };
      }
    }
    const errData = await resp.json().catch(() => ({}));
    if (resp.status === 404 || errData?.status === 404) {
      throw new Error(`Postcode "${postcode}" not found. Please check it and try again.`);
    }
  } catch (err) {
    if (err.message.includes('not found')) throw err;
    // Network error — fall through to fallback
    console.warn('postcodes.io failed, trying fallback', err);
  }

  // Fallback: ORS geocoding
  const apiKey = $('apiKey').value.trim();
  if (!apiKey) throw new Error('Could not geocode postcode. Please check your internet connection or enter an ORS API key.');

  const geoUrl = `https://api.openrouteservice.org/geocode/search?api_key=${encodeURIComponent(apiKey)}&text=${encodeURIComponent(postcode + ', UK')}&boundary.country=GB&size=1`;
  const geoResp = await fetch(geoUrl);
  if (!geoResp.ok) throw new Error(`Geocoding failed (${geoResp.status}). Please check the postcode.`);
  const geoData = await geoResp.json();
  if (!geoData.features?.length) throw new Error(`Could not locate postcode "${postcode}".`);
  const [lon, lat] = geoData.features[0].geometry.coordinates;
  return { lat, lon, formatted: postcode };
}

// ── ORS Route Request ──────────────────────────────────────────
/**
 * Requests a single circular route from ORS.
 *
 * ORS round-trip options:
 *   options.round_trip.length  – target distance in metres
 *   options.round_trip.points  – number of intermediate waypoints (2–6)
 *   options.round_trip.seed    – integer seed for reproducibility
 *
 * extra_info requests:
 *   waytype  – road type (footway, path, track, road…)
 *   surface  – surface type (gravel, grass, asphalt…)
 *
 * @param {number} lat
 * @param {number} lon
 * @param {number} targetMetres   – target route length in metres
 * @param {number} seed           – RNG seed (vary per route)
 * @param {number} points         – number of waypoints (2–5)
 * @param {string} apiKey
 * @returns {Promise<object>}     – raw ORS GeoJSON feature
 */
async function fetchORSRoute(lat, lon, targetMetres, seed, points, apiKey) {
  const body = {
    coordinates: [[lon, lat]],
    // profile is set via the URL path (/foot-walking/geojson)
    options: {
      round_trip: {
        length: targetMetres,  // target distance in metres
        points: points,         // number of intermediate waypoints (2–6)
        seed: seed              // RNG seed — varied per route for diversity
      },
      avoid_features: ['ferries']
    },
    // Request extra segment info for footpath% and surface% calculations
    extra_info: ['waytype', 'surface'],
    geometry: true,
    instructions: false,
    elevation: false
  };

  const resp = await fetch(`${ORS_BASE}/directions/foot-walking/geojson`, {
    method: 'POST',
    headers: {
      'Authorization': apiKey,
      'Content-Type': 'application/json',
      'Accept': 'application/json, application/geo+json'
    },
    body: JSON.stringify(body)
  });

  if (resp.status === 403 || resp.status === 401) {
    throw new Error('ORS API key is invalid or missing. Please check your key at openrouteservice.org.');
  }
  if (resp.status === 429) {
    throw new Error('ORS rate limit reached. Please wait a moment and try again (free tier: 40 req/min).');
  }
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    let msg = `ORS API error (${resp.status})`;
    try { const j = JSON.parse(errText); if (j.error?.message) msg += ': ' + j.error.message; } catch (_) {}
    throw new Error(msg);
  }

  const data = await resp.json();
  if (!data.features?.length) throw new Error('ORS returned no route features.');
  return data.features[0];
}

// ── Metrics calculation ────────────────────────────────────────

/**
 * Extracts waytype and surface extra_info from an ORS feature.
 * Returns { waytypeSegments, surfaceSegments } where each segment is { value, fromIndex, toIndex }.
 */
function extractExtras(feature) {
  const extras = feature.properties?.extras || {};
  const waytypeSegments = (extras.waytype?.values || []).map(([from, to, val]) => ({ from, to, val }));
  const surfaceSegments = (extras.surface?.values || []).map(([from, to, val]) => ({ from, to, val }));
  return { waytypeSegments, surfaceSegments };
}

/**
 * Calculates % of route coordinates covered by footpath-like waytypes.
 * We iterate coordinate pairs and check which waytype segment covers them.
 * @param {number[][]} coords  – array of [lon, lat] pairs
 * @param {object[]} waytypeSegments
 * @returns {number} percentage (0–100)
 */
function calcFootpathPercent(coords, waytypeSegments) {
  if (!waytypeSegments.length || coords.length < 2) return 50; // fallback estimate

  let footpathPoints = 0;
  for (const seg of waytypeSegments) {
    const segLen = seg.to - seg.from;
    if (FOOTPATH_WAYTYPES.has(seg.val)) {
      footpathPoints += segLen;
    }
  }

  const totalPoints = coords.length;
  return Math.round((footpathPoints / totalPoints) * 100);
}

/**
 * Estimates a natural-surface percentage from ORS surface extra_info.
 */
function calcNaturalSurfacePercent(coords, surfaceSegments) {
  if (!surfaceSegments.length || coords.length < 2) return null;
  let naturalPoints = 0;
  for (const seg of surfaceSegments) {
    if (NATURAL_SURFACES.has(seg.val)) naturalPoints += (seg.to - seg.from);
  }
  return Math.round((naturalPoints / coords.length) * 100);
}

/**
 * Computes a repetition score (0–100) by detecting retraced segments.
 *
 * Algorithm:
 *  1. Sample the route into fixed-length grid cells (~30m resolution).
 *  2. Count how many cells appear more than once (= retraced).
 *  3. Score = (retraced cells / total cells) * 100.
 *
 * A perfect loop scores near 0; an out-and-back scores ~50+.
 *
 * @param {number[][]} coords – array of [lon, lat]
 * @returns {number} repetition percentage (0–100)
 */
function calcRepetitionScore(coords) {
  if (coords.length < 4) return 0;

  // ~30m grid cells in degrees (~0.00027°)
  const CELL = 0.00027;
  const cellMap = new Map();
  let totalCells = 0;

  for (let i = 0; i < coords.length - 1; i++) {
    const [lon1, lat1] = coords[i];
    const [lon2, lat2] = coords[i + 1];

    // Sample points along this segment every ~15m
    const dLon = lon2 - lon1, dLat = lat2 - lat1;
    const dist = Math.sqrt(dLon * dLon + dLat * dLat);
    const steps = Math.max(1, Math.round(dist / (CELL * 0.5)));

    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const cLon = lon1 + dLon * t;
      const cLat = lat1 + dLat * t;
      const cellKey = `${Math.round(cLon / CELL)},${Math.round(cLat / CELL)}`;
      cellMap.set(cellKey, (cellMap.get(cellKey) || 0) + 1);
      totalCells++;
    }
  }

  let retracedCells = 0;
  for (const count of cellMap.values()) {
    if (count > 1) retracedCells += (count - 1);
  }

  return Math.min(100, Math.round((retracedCells / totalCells) * 100));
}

/**
 * Computes actual route length in km from coordinate array.
 * Uses Haversine formula.
 */
function calcRouteLength(coords) {
  let total = 0;
  for (let i = 0; i < coords.length - 1; i++) {
    total += haversine(coords[i][1], coords[i][0], coords[i + 1][1], coords[i + 1][0]);
  }
  return total / 1000; // metres → km
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const φ1 = lat1 * Math.PI / 180, φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Checks how far the route strays from the starting point.
 * Returns max distance in km from start to any coordinate.
 */
function calcMaxStray(coords, startLat, startLon) {
  let maxKm = 0;
  for (const [lon, lat] of coords) {
    const d = haversine(startLat, startLon, lat, lon) / 1000;
    if (d > maxKm) maxKm = d;
  }
  return maxKm;
}

// ── Route object builder ───────────────────────────────────────
function buildRouteObject(feature, index, startLat, startLon) {
  const coords = feature.geometry.coordinates; // [lon, lat][]
  const { waytypeSegments, surfaceSegments } = extractExtras(feature);

  const lengthKm     = calcRouteLength(coords);
  const footpathPct  = calcFootpathPercent(coords, waytypeSegments);
  const naturalPct   = calcNaturalSurfacePercent(coords, surfaceSegments);
  const repetition   = calcRepetitionScore(coords);
  const maxStrayKm   = calcMaxStray(coords, startLat, startLon);
  const durationMins = Math.round(lengthKm / 5.0 * 60); // ~5 km/h walking pace

  return {
    id: index,
    coords,       // [lon, lat][]
    lengthKm,
    footpathPct,
    naturalPct,
    repetition,
    maxStrayKm,
    durationMins,
    feature,
    colour: ROUTE_COLOURS[index % ROUTE_COLOURS.length],
    name: `Route ${index + 1}`
  };
}

// ── UI helpers ─────────────────────────────────────────────────
function setStatus(msg, type = 'info') {
  const bar = $('statusBar');
  if (!msg) { bar.style.display = 'none'; return; }
  bar.style.display = 'flex';
  bar.className = `status-bar ${type === 'error' ? 'error' : type === 'warning' ? 'warning' : ''}`;
  bar.innerHTML = type === 'loading'
    ? `<span class="spinner"></span><span>${msg}</span>`
    : `<span>${type === 'error' ? '⚠️' : type === 'warning' ? '⚡' : 'ℹ️'}</span><span>${msg}</span>`;
}

function setProgress(pct) {
  $('progressFill').style.width = `${pct}%`;
  $('progressTrack').style.display = pct >= 0 && pct < 100 ? 'block' : 'none';
}

function setGenerating(on) {
  const btn = $('generateBtn');
  if (on) {
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Generating…';
  } else {
    btn.disabled = false;
    btn.innerHTML = '🗺️ Generate Routes';
  }
}

let toastTimeout;
function showToast(msg) {
  let t = document.getElementById('toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'toast';
    t.style.cssText = `position:fixed;bottom:1.5rem;left:50%;transform:translateX(-50%);
      background:hsl(220 25% 15%);color:hsl(0 0% 92%);padding:0.6rem 1.2rem;
      border-radius:20px;font-size:0.8rem;z-index:9999;
      box-shadow:0 4px 20px hsl(0 0% 0%/0.4);
      transition:opacity 250ms ease;pointer-events:none;`;
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.style.opacity = '1';
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => { t.style.opacity = '0'; }, 2500);
}

// ── Validation ─────────────────────────────────────────────────
function validateInputs() {
  let valid = true;

  const postcode = $('postcode').value.trim();
  // Validate by stripping the optional internal space and checking compact form.
  // postcodes.io will reject truly invalid postcodes with a friendly error.
  const compact = postcode.replace(/\s/g, '');
  const ukPostcodeRe = /^[A-Z]{1,2}\d[A-Z\d]?\d[A-Z]{2}$/i;
  if (compact.length < 5 || !ukPostcodeRe.test(compact)) {
    showFieldError('postcode', 'Please enter a valid UK postcode (e.g. SW1A 1AA)');
    valid = false;
  } else {
    clearFieldError('postcode');
  }

  const minDist = parseFloat($('minDist').value);
  const maxDist = parseFloat($('maxDist').value);
  if (isNaN(minDist) || minDist < 1 || minDist > 100) {
    showFieldError('minDist', 'Enter a value between 1 and 100 km');
    valid = false;
  } else if (isNaN(maxDist) || maxDist < 1 || maxDist > 100) {
    showFieldError('maxDist', 'Enter a value between 1 and 100 km');
    valid = false;
  } else if (minDist >= maxDist) {
    showFieldError('maxDist', 'Max must be greater than min distance');
    valid = false;
  } else {
    clearFieldError('minDist');
    clearFieldError('maxDist');
  }

  const maxRadius = parseFloat($('maxRadius').value);
  if (isNaN(maxRadius) || maxRadius < 0.5 || maxRadius > 200) {
    showFieldError('maxRadius', 'Enter a value between 0.5 and 200 km');
    valid = false;
  } else {
    clearFieldError('maxRadius');
  }

  const apiKey = $('apiKey').value.trim();
  if (!apiKey) {
    showFieldError('apiKey', 'ORS API key is required. Get one free at openrouteservice.org');
    valid = false;
  } else {
    clearFieldError('apiKey');
  }

  // Scroll the first errored field into view so users notice the inline error messages
  if (!valid) {
    const firstErr = document.querySelector('.field-error.visible');
    if (firstErr) firstErr.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  return valid;
}

function showFieldError(fieldId, msg) {
  const inp = $(fieldId);
  inp.classList.add('invalid');
  const errEl = document.getElementById(`${fieldId}Error`);
  if (errEl) { errEl.textContent = msg; errEl.classList.add('visible'); }
}

function clearFieldError(fieldId) {
  const inp = $(fieldId);
  inp.classList.remove('invalid');
  const errEl = document.getElementById(`${fieldId}Error`);
  if (errEl) errEl.classList.remove('visible');
}

// ── Route list rendering ───────────────────────────────────────
function renderRouteList() {
  const sortVal = $('sortSelect').value;
  const sorted = [...routes].sort((a, b) => {
    if (sortVal === 'distance')     return a.lengthKm - b.lengthKm;
    if (sortVal === 'footpath')     return b.footpathPct - a.footpathPct;
    if (sortVal === 'repetition')   return a.repetition - b.repetition;
    if (sortVal === 'duration')     return a.durationMins - b.durationMins;
    return a.id - b.id;
  });

  const container = $('routesList');
  if (!sorted.length) {
    container.innerHTML = `
      <div class="empty-state">
        <span class="icon">🗺️</span>
        <h3>No routes yet</h3>
        <p>Enter a UK postcode and click Generate Routes to find circular walks near you.</p>
      </div>`;
    return;
  }

  container.innerHTML = '';
  for (const route of sorted) {
    const card = createRouteCard(route);
    container.appendChild(card);
  }
}

function createRouteCard(route) {
  const card = document.createElement('div');
  card.className = `route-card${route.id === activeRouteIndex ? ' active' : ''}`;
  card.dataset.routeId = route.id;

  const durationStr = route.durationMins >= 60
    ? `${Math.floor(route.durationMins / 60)}h ${route.durationMins % 60}m`
    : `${route.durationMins}m`;

  const footClass = route.footpathPct >= 70 ? 'good' : route.footpathPct >= 40 ? 'ok' : 'bad';
  const repClass  = route.repetition  <= 15 ? 'good' : route.repetition  <= 35 ? 'ok' : 'bad';
  const strayBadge = route.maxStrayKm > parseFloat($('maxRadius').value)
    ? `<span class="badge badge-amber" title="Strays beyond radius">⚠️ ${route.maxStrayKm.toFixed(1)} km</span>`
    : `<span class="badge badge-green">✓ In radius</span>`;

  // Colour swatch
  const swatch = `<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${route.colour};margin-right:4px;flex-shrink:0;"></span>`;

  card.innerHTML = `
    <div class="route-card__header">
      <span class="route-card__name">${swatch}${route.name}</span>
      <span class="route-card__distance">${route.lengthKm.toFixed(1)} km</span>
    </div>
    <div class="route-card__metrics">
      <div class="metric">
        <span class="metric__label">🥾 Footpaths</span>
        <span class="metric__value ${footClass}">${route.footpathPct}%</span>
      </div>
      <div class="metric">
        <span class="metric__label">🔄 Repetition</span>
        <span class="metric__value ${repClass}">${route.repetition}%</span>
      </div>
      <div class="metric">
        <span class="metric__label">⏱ Duration</span>
        <span class="metric__value">${durationStr}</span>
      </div>
    </div>
    <div style="margin-top:0.5rem;display:flex;align-items:center;justify-content:space-between;">
      ${strayBadge}
      ${route.naturalPct !== null ? `<span class="badge badge-blue">🌿 ${route.naturalPct}% natural</span>` : ''}
    </div>`;

  card.addEventListener('click', () => selectRoute(route.id));
  return card;
}

// ── Map rendering ──────────────────────────────────────────────
function clearMapRoutes() {
  for (const layer of routeLayers) map.removeLayer(layer);
  routeLayers = [];
  if (radiusCircle) { map.removeLayer(radiusCircle); radiusCircle = null; }
}

function showStartMarker(lat, lon, formatted) {
  if (startMarker) map.removeLayer(startMarker);

  const icon = L.divIcon({
    className: '',
    html: `<div style="
      width:36px;height:36px;border-radius:50%;
      background:var(--accent,#22c55e);
      border:3px solid white;
      box-shadow:0 2px 8px rgba(0,0,0,0.4);
      display:flex;align-items:center;justify-content:center;
      font-size:16px;color:white;font-weight:700;
    ">📍</div>`,
    iconSize: [36, 36],
    iconAnchor: [18, 18]
  });

  startMarker = L.marker([lat, lon], { icon, zIndexOffset: 1000 })
    .addTo(map)
    .bindPopup(`<strong>📍 ${formatted}</strong><br>Start / End point`);
}

function showRadiusCircle(lat, lon, radiusKm) {
  radiusCircle = L.circle([lat, lon], {
    radius: radiusKm * 1000,
    color: '#22c55e',
    weight: 1.5,
    opacity: 0.4,
    fillOpacity: 0.03,
    dashArray: '6 4'
  }).addTo(map);
}

function renderAllRoutes(startLat, startLon) {
  clearMapRoutes();
  const radiusKm = parseFloat($('maxRadius').value) || 10;
  showRadiusCircle(startLat, startLon, radiusKm);

  for (const route of routes) {
    const latlngs = route.coords.map(([lon, lat]) => [lat, lon]);
    const isActive = route.id === activeRouteIndex;

    const line = L.polyline(latlngs, {
      color: route.colour,
      weight: isActive ? 5 : 3,
      opacity: isActive ? 0.95 : 0.55,
      lineJoin: 'round',
      lineCap: 'round'
    }).addTo(map);

    line._routeId = route.id;  // Tag for reliable lookup
    line.on('click', () => selectRoute(route.id));
    line.bindTooltip(`${route.name} · ${route.lengthKm.toFixed(1)} km`, { sticky: true, className: '' });
    routeLayers.push(line);
  }
}

function selectRoute(id) {
  activeRouteIndex = id;
  const route = routes.find(r => r.id === id);
  if (!route) return;

  // Update card highlight
  document.querySelectorAll('.route-card').forEach(c => {
    c.classList.toggle('active', Number(c.dataset.routeId) === id);
  });

  // Zoom to route
  const latlngs = route.coords.map(([lon, lat]) => [lat, lon]);
  const bounds = L.latLngBounds(latlngs);
  map.fitBounds(bounds, { padding: [40, 40], maxZoom: 16 });

  // Update polyline widths
  routeLayers.forEach(layer => {
    const isActive = layer._routeId === id;
    layer.setStyle({ weight: isActive ? 6 : 2.5, opacity: isActive ? 0.95 : 0.35 });
    if (isActive) layer.bringToFront();
  });

  // Update info bar
  updateInfoBar(route);
}

function updateInfoBar(route) {
  const durationStr = route.durationMins >= 60
    ? `${Math.floor(route.durationMins / 60)}h ${route.durationMins % 60}m`
    : `${route.durationMins}m`;

  const infoBar = $('infoBar');
  infoBar.innerHTML = `
    <span class="info-item">📏 <strong>${route.lengthKm.toFixed(2)} km</strong></span>
    <span class="info-item">⏱ <strong>${durationStr}</strong> at 5 km/h</span>
    <span class="info-item">🥾 <strong>${route.footpathPct}%</strong> footpaths</span>
    <span class="info-item">🔄 <strong>${route.repetition}%</strong> repetition</span>
    <span class="info-item">📍 Max stray <strong>${route.maxStrayKm.toFixed(1)} km</strong></span>
    ${route.naturalPct !== null ? `<span class="info-item">🌿 <strong>${route.naturalPct}%</strong> natural surface</span>` : ''}
    <span class="info-item" style="margin-left:auto;">
      <button class="btn btn-secondary" id="gpxExportBtn"
        style="min-height:32px;padding:0.3rem 0.75rem;font-size:0.78rem;border-radius:var(--radius-sm);">
        ⬇ GPX
      </button>
    </span>
  `;
  document.getElementById('gpxExportBtn')?.addEventListener('click', () => exportGPX(route));
}

// ── Main generation flow ───────────────────────────────────────
async function generateRoutes() {
  if (!validateInputs()) return;

  const postcode  = $('postcode').value.trim();
  const minDist   = parseFloat($('minDist').value);
  const maxDist   = parseFloat($('maxDist').value);
  const maxRadius = parseFloat($('maxRadius').value);
  const apiKey    = $('apiKey').value.trim();
  const count     = parseInt($('routeCount').value) || 8;

  setGenerating(true);
  setProgress(0);
  routes = [];
  activeRouteIndex = -1;
  $('routesList').innerHTML = '';
  $('infoBar').innerHTML = '<span style="color:var(--text-muted)">Select a route to see details</span>';

  let startLat, startLon, formatted;

  try {
    // Step 1: Geocode
    setStatus('Locating postcode…', 'loading');
    setProgress(5);
    const geo = await geocodePostcode(postcode);
    startLat = geo.lat;
    startLon = geo.lon;
    formatted = geo.formatted;

    showStartMarker(startLat, startLon, formatted);
    map.setView([startLat, startLon], 13);
    setProgress(15);

    // Step 2: Generate N routes with varying seeds, distances, point counts
    const targetDistances = buildTargetDistances(minDist, maxDist, count);
    const seeds = buildSeeds(count);
    const pointCounts = [3, 4, 3, 5, 4, 3, 5, 4, 3, 4, 5, 3]; // cycle through

    let fetched = 0;
    const rawFeatures = [];
    const errors = [];

    for (let i = 0; i < count; i++) {
      const pct = 15 + Math.round((i / count) * 70);
      setProgress(pct);
      setStatus(`Generating route ${i + 1} of ${count}…`, 'loading');

      try {
        const targetM = targetDistances[i] * 1000;
        const pts = pointCounts[i % pointCounts.length];
        const feature = await fetchORSRoute(startLat, startLon, targetM, seeds[i], pts, apiKey);
        rawFeatures.push(feature);
        fetched++;
      } catch (err) {
        console.warn(`Route ${i + 1} failed:`, err.message);
        errors.push(err.message);
        // If we hit a rate limit or auth error, stop early
        if (err.message.includes('rate limit') || err.message.includes('invalid')) throw err;
      }

      // Small delay to avoid rate limits (free tier: 40 req/min = 1.5s between calls)
      if (i < count - 1) await sleep(1600);
    }

    setProgress(88);
    setStatus('Processing routes…', 'loading');

    // Step 3: Build route objects, filter by radius
    const allRoutes = rawFeatures.map((feat, i) =>
      buildRouteObject(feat, i, startLat, startLon)
    );

    // Filter: keep routes within radius (or flag them)
    routes = allRoutes.filter(r => r.maxStrayKm <= maxRadius * 1.5); // allow 50% overshoot before discarding
    if (!routes.length && allRoutes.length) {
      // Nothing fits — show all with warnings
      routes = allRoutes;
      setStatus(`All routes stray beyond ${maxRadius} km — showing anyway. Try increasing max radius.`, 'warning');
    }

    // Re-index for display
    routes.forEach((r, i) => { r.name = `Route ${i + 1}`; });

    setProgress(95);

    // Step 4: Render
    renderAllRoutes(startLat, startLon);
    renderRouteList();

    setProgress(100);
    setStatus(`Found ${routes.length} route${routes.length !== 1 ? 's' : ''}${errors.length ? ` (${errors.length} failed)` : ''}`, 'info');
    setProgress(-1);

    // Auto-select best route (lowest repetition + highest footpath)
    if (routes.length) {
      const best = [...routes].sort((a, b) =>
        (a.repetition - a.footpathPct) - (b.repetition - b.footpathPct)
      )[0];
      selectRoute(best.id);
    }

  } catch (err) {
    console.error('Generation failed:', err);
    setStatus(err.message || 'An error occurred. Please check your inputs and try again.', 'error');
    setProgress(-1);
  } finally {
    setGenerating(false);
  }
}

// ── Utility helpers ────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Generates N target distances evenly spread between minDist and maxDist,
 * with slight random jitter so routes feel distinct.
 */
function buildTargetDistances(min, max, n) {
  const dists = [];
  const range = max - min;
  for (let i = 0; i < n; i++) {
    const base = min + (range * i / (n - 1 || 1));
    const jitter = (Math.random() - 0.5) * range * 0.15;
    dists.push(Math.max(min, Math.min(max, base + jitter)));
  }
  return dists;
}

function buildSeeds(n) {
  // Mix of deterministic and random seeds for variety
  return Array.from({ length: n }, (_, i) => Math.floor(Math.random() * 90000) + i * 1337);
}

// ── Sort change ────────────────────────────────────────────────
function onSortChange() {
  renderRouteList();
}

// ── Keyboard & form shortcuts ──────────────────────────────────
function initFormShortcuts() {
  // Allow Enter in postcode to trigger generate
  $('postcode').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.isComposing) generateRoutes();
  });

  // Clear invalid state on change
  ['postcode', 'minDist', 'maxDist', 'maxRadius', 'apiKey'].forEach(id => {
    $(id)?.addEventListener('input', () => clearFieldError(id));
  });
}

// ── Postcode input formatting ──────────────────────────────────
function initPostcodeInput() {
  const inp = $('postcode');
  inp.addEventListener('input', () => {
    // Strip everything except letters, digits, spaces; uppercase
    let val = inp.value.toUpperCase().replace(/[^A-Z0-9 ]/g, '');
    // Collapse multiple spaces to one, trim
    val = val.replace(/\s+/g, ' ').trim();
    // Auto-insert space before last 3 chars if no space present and length > 3
    if (val.length > 3 && !val.includes(' ')) {
      const idx = val.length - 3;
      val = val.slice(0, idx) + ' ' + val.slice(idx);
    }
    inp.value = val;
  });
}


// ── GPX Export ─────────────────────────────────────────────────
/**
 * Generates a GPX file for a route and triggers download.
 * GPX is the standard format for GPS devices and most walk apps.
 */
function exportGPX(route) {
  const coords = route.coords;
  const now = new Date().toISOString();
  const trkpts = coords.map(([lon, lat]) =>
    `    <trkpt lat="${lat.toFixed(7)}" lon="${lon.toFixed(7)}"></trkpt>`
  ).join('\n');

  const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Circular Walk Finder" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata>
    <name>${route.name}</name>
    <desc>Circular walk - ${route.lengthKm.toFixed(2)} km - ${route.footpathPct}% footpaths</desc>
    <time>${now}</time>
    <keywords>circular walk, footpath, UK</keywords>
  </metadata>
  <trk>
    <name>${route.name}</name>
    <desc>${route.lengthKm.toFixed(2)} km circular walk. Footpaths: ${route.footpathPct}%. Repetition: ${route.repetition}%.</desc>
    <trkseg>
${trkpts}
    </trkseg>
  </trk>
</gpx>`;

  const blob = new Blob([gpx], { type: 'application/gpx+xml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `circular-walk-${route.name.toLowerCase().replace(' ', '-')}.gpx`;
  a.click();
  URL.revokeObjectURL(url);
  showToast(`Downloaded ${a.download}`);
}

// ── Init ───────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  initApiKey();
  initMap();
  initFormShortcuts();
  initPostcodeInput();

  $('generateBtn').addEventListener('click', generateRoutes);
  $('sortSelect').addEventListener('change', onSortChange);

  // Start with empty state shown
  renderRouteList();

  // Show legend
  const legend = document.getElementById('mapLegend');
  if (legend) {
    legend.innerHTML = `
      <h4>Route Colours</h4>
      ${ROUTE_COLOURS.slice(0, 5).map((c, i) => `
        <div class="legend-item">
          <div class="legend-swatch" style="background:${c}"></div>
          <span>Route ${i + 1}</span>
        </div>`).join('')}
      <div class="legend-item" style="margin-top:4px;opacity:0.6;font-size:0.65rem;">+ more…</div>
    `;
  }
});
