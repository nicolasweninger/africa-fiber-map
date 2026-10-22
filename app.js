/* Africa Fiber Map — vanilla JS + MapLibre GL JS 4.
 * Renders subsea cables, terrestrial lines, landing stations and cities from
 * the window.* data globals defined by data/*.js, with a filter sidebar.
 * GPU-accelerated continuous zoom (the reason for the Leaflet→MapLibre move).
 * Every data lookup degrades gracefully: missing annotations / meta never throw. */
(function () {
  "use strict";

  // ---- Safe access to the data globals (any may be missing during dev) ----
  var CABLES_GEO     = window.CABLES_GEO     || { type: "FeatureCollection", features: [] };
  var CABLES_META    = window.CABLES_META    || {};
  var LANDING_POINTS = window.LANDING_POINTS || { type: "FeatureCollection", features: [] };
  var TERRESTRIAL    = window.TERRESTRIAL    || { type: "FeatureCollection", features: [] };
  var CITIES         = window.CITIES         || { type: "FeatureCollection", features: [] };
  var ANN            = window.ANNOTATIONS    || {};
  var ANN_CABLES  = ANN.cables         || {};
  var ANN_REGIONS = ANN.regions        || {};
  var ANN_CR      = ANN.country_region || {};
  var ANN_LAT     = ANN.latency        || {};
  var ANN_SL      = ANN.starlink       || {};
  var mobileLayout = window.matchMedia("(max-width: 768px), (max-height: 500px) and (pointer: coarse)");
  var coarsePointer = window.matchMedia("(pointer: coarse)");

  var TERR_COLOR = "#64748b"; // muted slate, distinct from TeleGeography subsea colors

  // ---- terrestrial geometry thinning (in-memory, at load) ----
  // Terrestrial is aggregated background context: ~7,670 line segments / ~30k points.
  // Ramer-Douglas-Peucker at ~0.04 deg (~4km) removes ~28% of the points with no visible
  // change at these context zooms, shrinking the GeoJSON MapLibre has to tile on first
  // load. We rebuild a thinned copy so the source data object stays untouched; feature
  // properties (used by the tooltips) are carried through unchanged, plus a derived `pl`
  // (planned) boolean the line layers filter on.
  var TERR_THIN_TOL = 0.04; // degrees; simplification tolerance in [lng,lat] space
  function pointSegDist(p, a, b) {
    var x = p[0], y = p[1], x1 = a[0], y1 = a[1], x2 = b[0], y2 = b[1];
    var dx = x2 - x1, dy = y2 - y1, l2 = dx * dx + dy * dy;
    if (l2 === 0) { var ex = x - x1, ey = y - y1; return Math.sqrt(ex * ex + ey * ey); }
    var t = ((x - x1) * dx + (y - y1) * dy) / l2;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    var px = x1 + t * dx, py = y1 + t * dy, ddx = x - px, ddy = y - py;
    return Math.sqrt(ddx * ddx + ddy * ddy);
  }
  function rdpLine(pts, tol) {
    if (!pts || pts.length < 3) return pts;
    var dmax = 0, idx = 0;
    for (var i = 1; i < pts.length - 1; i++) {
      var d = pointSegDist(pts[i], pts[0], pts[pts.length - 1]);
      if (d > dmax) { dmax = d; idx = i; }
    }
    if (dmax > tol) {
      return rdpLine(pts.slice(0, idx + 1), tol).slice(0, -1).concat(rdpLine(pts.slice(idx), tol));
    }
    return [pts[0], pts[pts.length - 1]];
  }
  function terrPlanned(p) { p = p || {}; return (p.status === "planned" || p.live === false); }
  function thinTerrestrial(fc) {
    var out = { type: "FeatureCollection", features: [] };
    (fc.features || []).forEach(function (f, i) {
      var g = f && f.geometry;
      var props = Object.assign({}, (f && f.properties) || {});
      props.pl = terrPlanned(props);
      props.fid = i; // unique per-feature id so paint expressions can target one line (click-to-pin)
      if (!g || !g.coordinates) { out.features.push({ type: "Feature", id: i, properties: props, geometry: g }); return; }
      var ng;
      if (g.type === "LineString") {
        ng = { type: "LineString", coordinates: rdpLine(g.coordinates, TERR_THIN_TOL) };
      } else if (g.type === "MultiLineString") {
        ng = { type: "MultiLineString", coordinates: g.coordinates.map(function (line) { return rdpLine(line, TERR_THIN_TOL); }) };
      } else {
        out.features.push({ type: "Feature", id: i, properties: props, geometry: g }); return; // leave any non-line geometry as-is
      }
      out.features.push({ type: "Feature", id: i, properties: props, geometry: ng });
    });
    return out;
  }
  TERRESTRIAL = thinTerrestrial(TERRESTRIAL);

  // ---------- small helpers ----------
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function slugify(s) {
    return String(s || "")
      .toLowerCase()
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // strip accents
      .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  }
  function has(v) { return v != null && v !== ""; }
  function fmtUSD(n) { return Number(n).toLocaleString("en-US"); }
  function round5(n) { return Math.round(n / 5) * 5; }
  function lsGet(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }

  // Make a side panel collapsible to a 36px rail (styles in app.css). Appends the
  // collapse button + rail to `el`; the caller persists state via onChange and
  // re-layouts (map.resize) via onSettle, which fires after the width transition.
  // opts: { label, initial, onChange(collapsed), onSettle() }
  function attachCollapse(el, opts) {
    opts = opts || {};
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "side-collapse";
    btn.title = "Collapse";
    btn.innerHTML = "&laquo;";
    var rail = document.createElement("div");
    rail.className = "side-rail";
    rail.setAttribute("role", "button");
    rail.tabIndex = 0;
    rail.title = "Expand";
    var chev = document.createElement("span");
    chev.className = "side-rail-chev";
    chev.innerHTML = "&raquo;";
    var lab = document.createElement("span");
    lab.className = "side-rail-label";
    lab.textContent = opts.label || "";
    rail.appendChild(chev);
    rail.appendChild(lab);
    el.appendChild(btn);
    el.appendChild(rail);
    function set(collapsed) {
      el.classList.toggle("collapsed", !!collapsed);
      if (opts.onChange) opts.onChange(!!collapsed);
      var done = false;
      function fire() {
        if (done) return;
        done = true;
        el.removeEventListener("transitionend", fire);
        if (opts.onSettle) opts.onSettle();
      }
      el.addEventListener("transitionend", fire);
      setTimeout(fire, 220); // reduced-motion / no-transition fallback
    }
    btn.addEventListener("click", function () { set(true); });
    rail.addEventListener("click", function () { set(false); });
    rail.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); set(false); }
    });
    if (opts.initial) el.classList.add("collapsed"); // no animation/callbacks on init
    return { set: set, get: function () { return el.classList.contains("collapsed"); }, button: btn };
  }

  // Estimated Starlink RTT for a country: local access median + fiber leg from the
  // nearest Starlink PoP (per ANN.starlink), rounded to 5 ms. North Africa routes via
  // European gateways (fixed europe_gateway values). Returns null when unmapped.
  function starlinkRTT(country) {
    var region = ANN_CR[country];
    if (!region || !ANN_SL || !ANN_SL.pop_by_region) return null;
    if (region === "north_africa") {
      var g = ANN_SL.europe_gateway || {};
      return { us_east_ms: g.us_east_ms, us_west_ms: g.us_west_ms, europe_ms: g.europe_ms };
    }
    var pop = ANN_LAT[ANN_SL.pop_by_region[region]];
    if (!pop) return null;
    var local = (ANN_SL.local_ms_by_country && ANN_SL.local_ms_by_country[country] != null)
      ? ANN_SL.local_ms_by_country[country] : ANN_SL.default_local_ms;
    function d(dest) { return has(pop[dest]) ? round5(local + pop[dest]) : null; }
    return { us_east_ms: d("us_east_ms"), us_west_ms: d("us_west_ms"), europe_ms: d("europe_ms") };
  }

  // Truncate a comma-separated list to the first `n` items, appending "+N more".
  // Keeps the tooltip compact; the full value stays in the data.
  function truncateList(s, n) {
    var items = String(s).split(",").map(function (x) { return x.trim(); }).filter(Boolean);
    if (items.length <= n) return esc(items.join(", "));
    return esc(items.slice(0, n).join(", ")) +
           ' <span class="tt-more">+' + (items.length - n) + ' more</span>';
  }

  // ---------- cable feature index + slug↔numeric-id maps ----------
  // MapLibre feature-state / dimming keys on the numeric feature id; the sidebar and
  // tooltips key on the TeleGeography slug (properties.id). We keep both maps.
  var cableFeatureById = {}; // slug -> original GeoJSON feature
  var slugToId = {};         // slug -> numeric index
  var idToSlug = {};         // numeric index -> slug
  (CABLES_GEO.features || []).forEach(function (f) {
    var id = f && f.properties && f.properties.id;
    if (id) cableFeatureById[id] = f;
  });

  // ---------- cable metadata / annotation helpers ----------
  function cableIsPlanned(id) {
    var m = CABLES_META[id];
    return !!(m && m.is_planned);
  }
  function cableName(id) {
    var m = CABLES_META[id];
    if (m && m.name) return m.name;
    var f = cableFeatureById[id];
    return (f && f.properties && f.properties.name) || id;
  }
  function cableColor(id) {
    var f = cableFeatureById[id];
    return (f && f.properties && f.properties.color) || "#888888";
  }
  function capacityText(id) {
    var a = ANN_CABLES[id];
    if (a && a.capacity_tbps != null) return a.capacity_tbps + " Tbps";
    return "not public";
  }
  // Regions a cable touches, via its landing-point countries → country_region → regions.
  function cableRegionKeys(id) {
    var m = CABLES_META[id];
    var keys = [], seen = {};
    var lps = (m && m.landing_points) || [];
    lps.forEach(function (lp) {
      var k = ANN_CR[lp && lp.country];
      if (k && !seen[k]) { seen[k] = 1; keys.push(k); }
    });
    return keys;
  }

  // Build the cables GeoJSON source: numeric feature id, and the properties the line
  // layers style/filter on (slug id, name, color, planned).
  var cablesFC = { type: "FeatureCollection", features: [] };
  var cableOrder = [];
  (CABLES_GEO.features || []).forEach(function (f, i) {
    var slug = f && f.properties && f.properties.id;
    if (!slug) return;
    slugToId[slug] = i;
    idToSlug[i] = slug;
    cablesFC.features.push({
      type: "Feature",
      id: i,
      properties: {
        id: slug,
        name: (f.properties && f.properties.name) || slug,
        color: (f.properties && f.properties.color) || "#888888",
        planned: cableIsPlanned(slug)
      },
      geometry: f.geometry
    });
    cableOrder.push(slug);
  });
  cableOrder.sort(function (a, b) {
    return cableName(a).toLowerCase().localeCompare(cableName(b).toLowerCase());
  });

  // Landing-point source: numeric feature id so the hover handler can look the real
  // properties (incl. the `cables` array) back up — MapLibre stringifies array/object
  // feature properties, so we never read them off the rendered feature.
  var landingFC = { type: "FeatureCollection", features: [] };
  (LANDING_POINTS.features || []).forEach(function (f, i) {
    if (!f || !f.geometry || !f.geometry.coordinates) return;
    landingFC.features.push({ type: "Feature", id: i, properties: f.properties || {}, geometry: f.geometry });
  });

  // ---------- tooltip builders ----------
  // Short, tooltip-friendly region labels (the data `label` fields are longer).
  var SHORT_REGION = {
    west_africa: "West Africa",
    southern_africa: "Southern Africa",
    east_africa: "East Africa",
    north_africa: "North Africa"
  };
  // One dedicated cost line per region: "Egress (West Africa): ~$5/Mbps/mo (est.)".
  // Returns "" when the region has no numeric cost, so the line is omitted entirely.
  function egressLineHTML(key) {
    var r = ANN_REGIONS[key];
    if (!r || r.cost_usd_gbps_mo == null) return "";
    var label = SHORT_REGION[key] || r.label || key;
    return '<div class="tt-egress"><span class="tt-k">Egress (' + esc(label) + '):</span> ~$' +
           esc(fmtUSD(r.cost_usd_gbps_mo)) + '/Gbps·mo <span class="tt-est">(est.)</span></div>';
  }
  // Wrap the per-region cost lines in a visually distinct block, set off from the
  // plain metadata rows by a divider.
  function regionBenchmarkHTML(keys) {
    if (!keys || !keys.length) return "";
    var lines = keys.map(egressLineHTML).filter(Boolean);
    if (!lines.length) return "";
    return '<div class="tt-egress-block">' + lines.join("") + '</div>';
  }

  function cableTooltipHTML(id) {
    var m = CABLES_META[id] || {};
    var planned = cableIsPlanned(id);
    var badge = planned
      ? '<span class="tt-badge planned">Planned</span>'
      : '<span class="tt-badge live">Live</span>';

    var rows = [];
    rows.push('<div class="tt-title">' + esc(cableName(id)) + ' ' + badge + '</div>');
    if (has(m.owners))    rows.push('<div class="tt-row"><span class="tt-k">Owners:</span> ' + truncateList(m.owners, 10) + '</div>');
    if (has(m.suppliers)) rows.push('<div class="tt-row"><span class="tt-k">Supplier:</span> ' + esc(m.suppliers) + '</div>');
    if (has(m.length))    rows.push('<div class="tt-row"><span class="tt-k">Length:</span> ' + esc(m.length) + '</div>');
    rows.push('<div class="tt-row"><span class="tt-k">Capacity:</span> ' + esc(capacityText(id)) +
              (ANN_CABLES[id] && ANN_CABLES[id].capacity_tbps != null ? ' <span class="tt-est">(est.)</span>' : '') + '</div>');
    if (has(m.rfs_year)) rows.push('<div class="tt-row"><span class="tt-k">RFS:</span> ' + esc(m.rfs_year) + '</div>');
    rows.push(regionBenchmarkHTML(cableRegionKeys(id)));
    return rows.join("");
  }

  function terrestrialTooltipHTML(p) {
    p = p || {};
    var rows = [];
    rows.push('<div class="tt-title">' + esc(p.operator || p.owner || "Terrestrial link") + '</div>');
    var statusBadge = (p.status === "planned" || p.live === false)
      ? '<span class="tt-badge planned">Planned</span>'
      : '<span class="tt-badge live">Live</span>';
    rows.push('<div class="tt-row">' + statusBadge +
              ' <span class="tt-k">tier:</span> ' + esc(p.tier || "?") + ' <span class="kind">(derived)</span></div>');
    if (has(p.country))    rows.push('<div class="tt-row"><span class="tt-k">Country:</span> ' + esc(p.country) + '</div>');
    if (has(p.technology)) rows.push('<div class="tt-row"><span class="tt-k">Technology:</span> ' + esc(p.technology) + '</div>');
    if (has(p.go_live))    rows.push('<div class="tt-row"><span class="tt-k">Go-live:</span> ' + esc(p.go_live) + '</div>');
    return rows.join("");
  }

  function latencyTableHTML(slug, country) {
    var l = ANN_LAT[slug];
    if (!l) return '<div class="tt-note">No latency estimate for this location.</div>';
    function cell(v) { return has(v) ? esc(v) + ' ms' : '—'; }
    var euRef = has(l.europe_ref) ? ' <span class="kind">(' + esc(l.europe_ref) + ')</span>' : '';
    var kind = has(l.kind) ? ' <span class="kind">' + esc(l.kind) + '</span>' : '';
    var sl = state.starlink ? starlinkRTT(country) : null;
    // With Starlink on, prepend a row-label column so the fiber and Starlink rows are distinct.
    var head = sl ? '<th></th>' : '';
    var fLbl = sl ? '<td class="lat-lbl">Fiber</td>' : '';
    var html = '<table class="lat">' +
      '<tr>' + head + '<th>US East</th><th>US West</th><th>Europe' + euRef + '</th></tr>' +
      '<tr>' + fLbl + '<td>' + cell(l.us_east_ms) + '</td><td>' + cell(l.us_west_ms) + '</td><td>' + cell(l.europe_ms) + '</td></tr>';
    if (sl) {
      html += '<tr class="lat-sl"><td class="lat-lbl">Starlink</td><td>' + cell(sl.us_east_ms) +
              '</td><td>' + cell(sl.us_west_ms) + '</td><td>' + cell(sl.europe_ms) + '</td></tr>';
    }
    return html + '</table>' +
      '<div class="tt-row"><span class="tt-est">RTT est.</span>' + kind + '</div>';
  }

  function landingTooltipHTML(p) {
    p = p || {};
    var rows = [];
    rows.push('<div class="tt-title">' + esc(p.name || p.city || "Landing station") + '</div>');
    if (has(p.country)) rows.push('<div class="tt-sub">' + esc(p.country) + '</div>');

    // Cables landing here (names + colored dots).
    var cables = (p.cables || []);
    if (cables.length) {
      rows.push('<div class="tt-row"><span class="tt-k">Cables landing:</span></div>');
      rows.push(cables.map(function (cid) {
        return '<div class="cable-line"><span class="cable-dot" style="background:' + esc(cableColor(cid)) + '"></span>' +
               esc(cableName(cid)) + (cableIsPlanned(cid) ? ' <span class="kind">planned</span>' : '') + '</div>';
      }).join(""));
    }

    // Latency + region benchmark.
    var slug = slugify(p.city || p.name);
    rows.push(latencyTableHTML(slug, p.country));
    var rkey = ANN_CR[p.country];
    if (rkey) rows.push(regionBenchmarkHTML([rkey]));
    return rows.join("");
  }

  function cityTooltipHTML(p) {
    p = p || {};
    var rows = [];
    rows.push('<div class="tt-title">' + esc(p.name || "City") + '</div>');
    if (has(p.country)) rows.push('<div class="tt-sub">' + esc(p.country) + '</div>');
    var slug = p.slug || slugify(p.name);
    rows.push(latencyTableHTML(slug, p.country));
    return rows.join("");
  }

  // ================= state =================
  var state = {
    status: { subsea_live: true, subsea_planned: true, terr_live: true, terr_planned: true },
    terrTier: { core: true, distribution: true, access: true },
    points: { landing: true, cities: true },
    starlink: false, // Starlink RTT overlay in latency tooltips (default OFF)
    cableChecked: {} // slug -> bool
  };
  cableOrder.forEach(function (id) { state.cableChecked[id] = true; });

  function cableVisible(id) {
    if (!state.cableChecked[id]) return false;
    return cableIsPlanned(id) ? state.status.subsea_planned : state.status.subsea_live;
  }

  // ================= map =================
  var TIER_WIDTH = ["match", ["get", "tier"], "core", 2.5, "distribution", 1.5, "access", 0.8, 1.2];

  // Inline style — no external style JSON, no glyphs/sprites (works from file://).
  var cartoBasemapKey = window.CARTO_BASEMAP_KEY || "";
  var cartoTileUrl = "https://basemaps.cartocdn.com/rastertiles/light_all/{z}/{x}/{y}.png";
  if (cartoBasemapKey) cartoTileUrl += "?key=" + encodeURIComponent(cartoBasemapKey);
  var style = {
    version: 8,
    sources: {
      carto: {
        type: "raster",
        tiles: [cartoTileUrl],
        tileSize: 256,
        // Full human-readable attribution is rendered in the footer bar instead.
        attribution: "© OpenStreetMap contributors, © CARTO"
      }
    },
    layers: [
      { id: "basemap", type: "raster", source: "carto" }
    ]
  };

  var map = new maplibregl.Map({
    container: "map",
    style: style,
    center: [17, 2],
    zoom: mobileLayout.matches ? 2 : 3.2,
    minZoom: mobileLayout.matches ? 1.5 : 2,
    maxZoom: 19,
    renderWorldCopies: true,
    attributionControl: false, // attribution lives in the footer bar
    dragRotate: false,
    pitchWithRotate: false
  });
  map.touchZoomRotate.disableRotation();
  // Expose for verification / debugging, and as the extension surface used by
  // overlay modules (sites.js). Extensions push callbacks onto window.__fmExt;
  // each is invoked once with this object after the base map content is built.
  window.__map = map;
  window.__fiberMap = {
    map: map, state: state, applyVisibility: applyVisibility,
    ui: { section: section, checkboxRow: checkboxRow, collapse: attachCollapse },
    esc: esc, slugify: slugify, has: has,
    showPinCard: showPinCard, closePin: closePin,
    starlinkRTT: starlinkRTT, countryRegion: ANN_CR
  };

  // ---------- cable highlight / dimming (global paint expressions) ----------
  // Hovering or pinning a cable widens it and dims every other cable. Rather than
  // toggling feature-state on ~300 features, we swap the two cable layers' width/opacity
  // to expressions keyed on the active slug — one setPaintProperty pair per layer.
  var CABLE_LAYERS = ["cables-live", "cables-planned"];
  function setCableHighlight(slug) {
    var w = ["case", ["==", ["get", "id"], slug], 4, 1.8];
    var o = ["case", ["==", ["get", "id"], slug], 1, 0.12];
    CABLE_LAYERS.forEach(function (lid) {
      if (!map.getLayer(lid)) return;
      map.setPaintProperty(lid, "line-width", w);
      map.setPaintProperty(lid, "line-opacity", o);
    });
  }
  function clearCableHighlight() {
    if (map.getLayer("cables-live")) {
      map.setPaintProperty("cables-live", "line-width", 1.8);
      map.setPaintProperty("cables-live", "line-opacity", 0.9);
    }
    if (map.getLayer("cables-planned")) {
      map.setPaintProperty("cables-planned", "line-width", 1.8);
      map.setPaintProperty("cables-planned", "line-opacity", 0.55);
    }
  }
  // ---------- terrestrial highlight (per-feature, keyed on injected fid) ----------
  // Unlike cables, emphasising a terrestrial line does NOT dim the rest: we only bump the
  // clicked line's width (×2 its tier width) and darken it to near-black. Both terr layers
  // get the same case-expressions so a Multi-part / either-status line stays consistent.
  var TERR_LAYERS = ["terr-live", "terr-planned"];
  var TERR_HL_COLOR = "#0f172a"; // near-black slate-900, emphasised against the muted TERR_COLOR
  function setTerrHighlight(fid) {
    var w = ["case", ["==", ["get", "fid"], fid], ["*", TIER_WIDTH, 2], TIER_WIDTH];
    var c = ["case", ["==", ["get", "fid"], fid], TERR_HL_COLOR, TERR_COLOR];
    TERR_LAYERS.forEach(function (lid) {
      if (!map.getLayer(lid)) return;
      map.setPaintProperty(lid, "line-width", w);
      map.setPaintProperty(lid, "line-color", c);
    });
  }
  function clearTerrHighlight() {
    TERR_LAYERS.forEach(function (lid) {
      if (!map.getLayer(lid)) return;
      map.setPaintProperty(lid, "line-width", TIER_WIDTH);
      map.setPaintProperty(lid, "line-color", TERR_COLOR);
    });
  }

  // Return to the resting state: whichever feature is pinned keeps its highlight, everything
  // else back to normal. Cable and terrestrial pins are mutually exclusive (see pin*).
  function restoreHighlight() {
    if (pinnedCableId) setCableHighlight(pinnedCableId);
    else clearCableHighlight();
    if (pinnedTerrId != null) setTerrHighlight(pinnedTerrId);
    else clearTerrHighlight();
  }

  // ---------- click-to-pin: ONE pinned feature at a time GLOBALLY (cable XOR terrestrial) ----------
  // The pinned content lives in a fixed card docked top-right of the map area — NOT a
  // map-anchored popup — so it never obscures the clicked geometry. At most one of
  // pinnedCableId / pinnedTerrId is set; the map-anchored highlight (cable dim/highlight or
  // terrestrial emphasis) is applied as specced. Clicking another feature replaces the card
  // content and moves the highlight; the × (or a click on empty map) closes + restores.
  var pinnedCableId = null;
  var pinnedTerrId = null;
  var pinCardEl = null, pinCardBody = null;

  function ensurePinCard() {
    if (pinCardEl) return;
    var wrap = document.getElementById("map-wrap");
    pinCardEl = document.createElement("div");
    pinCardEl.className = "fm-pin-card";
    pinCardEl.hidden = true;
    var close = document.createElement("button");
    close.type = "button";
    close.className = "fm-pin-close";
    close.setAttribute("aria-label", "Close");
    close.innerHTML = "&times;";
    close.addEventListener("click", closePin);
    pinCardBody = document.createElement("div");
    pinCardBody.className = "fm-tt fm-popup-body";
    pinCardEl.appendChild(close);
    pinCardEl.appendChild(pinCardBody);
    wrap.appendChild(pinCardEl);
  }
  function showPinCard(html) {
    ensurePinCard();
    pinCardBody.innerHTML = html;
    pinCardEl.scrollTop = 0;
    pinCardEl.hidden = false;
  }
  // × / empty-map-click: drop the pin and restore all styling to resting state.
  function closePin() {
    pinnedCableId = null;
    pinnedTerrId = null;
    if (pinCardEl) pinCardEl.hidden = true;
    clearCableHighlight();
    clearTerrHighlight();
  }
  function pinCable(slug) {
    pinnedCableId = slug;
    pinnedTerrId = null;
    showPinCard(cableTooltipHTML(slug));
    clearTerrHighlight();      // drop any terrestrial emphasis
    setCableHighlight(slug);
  }
  function pinTerr(fid, props) {
    pinnedTerrId = fid;
    pinnedCableId = null;
    showPinCard(terrestrialTooltipHTML(props));
    clearCableHighlight();     // drop any cable emphasis (from hover)
    setTerrHighlight(fid);
  }
  function pinPoint(html) {
    pinnedCableId = null;
    pinnedTerrId = null;
    showPinCard(html);
    clearCableHighlight();
    clearTerrHighlight();
  }

  // ---------- hover popup (cursor-following) ----------
  var hoverPopup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, className: "fm-tt", offset: 10, maxWidth: "320px" });

  // ================= visibility =================
  function applyVisibility() {
    if (!map.getLayer("cables-live")) return; // layers not added yet
    // terrestrial: tier filter (setFilter) + status on/off (visibility)
    var tiers = Object.keys(state.terrTier).filter(function (k) { return state.terrTier[k]; });
    map.setFilter("terr-live",    ["all", ["!", ["get", "pl"]], ["in", ["get", "tier"], ["literal", tiers]]]);
    map.setFilter("terr-planned", ["all", ["get", "pl"],        ["in", ["get", "tier"], ["literal", tiers]]]);
    map.setLayoutProperty("terr-live",    "visibility", state.status.terr_live ? "visible" : "none");
    map.setLayoutProperty("terr-planned", "visibility", state.status.terr_planned ? "visible" : "none");

    // cables: visible iff own checkbox AND its status tier is on
    var vis = cableOrder.filter(cableVisible);
    map.setFilter("cables-live",    ["all", ["!", ["get", "planned"]], ["in", ["get", "id"], ["literal", vis]]]);
    map.setFilter("cables-planned", ["all", ["get", "planned"],        ["in", ["get", "id"], ["literal", vis]]]);

    // points
    map.setLayoutProperty("stations", "visibility", state.points.landing ? "visible" : "none");
    map.setLayoutProperty("cities",   "visibility", state.points.cities ? "visible" : "none");

    restoreHighlight(); // keep the pinned cable highlighted across visibility changes
  }

  // ================= layers + interactions (once the style is ready) =================
  // Drive setup from 'style.load' (fires when the inline style finishes parsing) rather
  // than 'load' — 'load' additionally waits on the first full render, which never
  // completes when the CARTO basemap tiles are unreachable (offline / file://). The
  // vectors + sidebar must come up regardless of whether the basemap tiles load.
  var contentInited = false;
  function initMapContent() {
    if (contentInited) return;
    contentInited = true;
    map.addSource("terrestrial", { type: "geojson", data: TERRESTRIAL });
    map.addSource("cables",      { type: "geojson", data: cablesFC });
    map.addSource("landing",     { type: "geojson", data: landingFC });
    map.addSource("cities",      { type: "geojson", data: CITIES });

    // Draw order: terrestrial < cables < stations < cities.
    map.addLayer({
      id: "terr-live", type: "line", source: "terrestrial",
      filter: ["!", ["get", "pl"]],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": TERR_COLOR, "line-width": TIER_WIDTH, "line-opacity": 0.85 }
    });
    map.addLayer({
      id: "terr-planned", type: "line", source: "terrestrial",
      filter: ["get", "pl"],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": TERR_COLOR, "line-width": TIER_WIDTH, "line-opacity": 0.6, "line-dasharray": [3, 3] }
    });
    map.addLayer({
      id: "cables-live", type: "line", source: "cables",
      filter: ["!", ["get", "planned"]],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": ["get", "color"], "line-width": 1.8, "line-opacity": 0.9 }
    });
    map.addLayer({
      id: "cables-planned", type: "line", source: "cables",
      filter: ["get", "planned"],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": ["get", "color"], "line-width": 1.8, "line-opacity": 0.55, "line-dasharray": [3, 3] }
    });
    map.addLayer({
      id: "stations", type: "circle", source: "landing",
      paint: {
        "circle-radius": 4, "circle-color": "#14b8a6",
        "circle-stroke-color": "#0f766e", "circle-stroke-width": 1.5, "circle-opacity": 0.9
      }
    });
    map.addLayer({
      id: "cities", type: "circle", source: "cities",
      paint: {
        "circle-radius": 4, "circle-color": "#334155",
        "circle-stroke-color": "#ffffff", "circle-stroke-width": 1.5, "circle-opacity": 1
      }
    });

    // ---- interactions ----
    function cursor(on) { map.getCanvas().style.cursor = on ? "pointer" : ""; }

    // Generic hover binder for the non-cable layers.
    function bindHover(layerId, htmlFn) {
      map.on("mousemove", layerId, function (e) {
        if (coarsePointer.matches) return;
        cursor(true);
        hoverPopup.setLngLat(e.lngLat).setHTML(htmlFn(e.features[0])).addTo(map);
      });
      map.on("mouseleave", layerId, function () {
        cursor(false);
        hoverPopup.remove();
      });
    }

    bindHover("terr-live",    function (f) { return terrestrialTooltipHTML(f.properties); });
    bindHover("terr-planned", function (f) { return terrestrialTooltipHTML(f.properties); });
    // Landing: read the real properties (with the `cables` array) from the source object,
    // keyed by numeric feature id — rendered props have arrays stringified.
    bindHover("stations", function (f) {
      var real = (LANDING_POINTS.features[f.id] && LANDING_POINTS.features[f.id].properties) || f.properties;
      return landingTooltipHTML(real);
    });
    bindHover("cities", function (f) { return cityTooltipHTML(f.properties); });

    // Cables: hover → highlight + dim others + cursor-following tooltip; click → pin.
    CABLE_LAYERS.forEach(function (lid) {
      map.on("mousemove", lid, function (e) {
        if (coarsePointer.matches) return;
        cursor(true);
        var slug = e.features[0].properties.id;
        setCableHighlight(slug);
        hoverPopup.setLngLat(e.lngLat).setHTML(cableTooltipHTML(slug)).addTo(map);
      });
      map.on("mouseleave", lid, function () {
        cursor(false);
        hoverPopup.remove();
        restoreHighlight(); // keep an active pin highlighted; else reset
      });
    });

    var PIN_LAYERS = CABLE_LAYERS.concat(TERR_LAYERS, ["stations", "cities"]);
    map.on("click", function (e) {
      var layers = PIN_LAYERS.filter(function (lid) { return map.getLayer(lid); });
      if (!layers.length) return;
      var query = e.point;
      if (coarsePointer.matches) {
        query = [
          [e.point.x - 12, e.point.y - 12],
          [e.point.x + 12, e.point.y + 12]
        ];
      }
      var hits = map.queryRenderedFeatures(query, { layers: layers });
      if (!hits.length) { closePin(); return; }
      var hit = hits[0];
      var layerId = hit.layer.id;
      hoverPopup.remove();
      if (CABLE_LAYERS.indexOf(layerId) !== -1) {
        pinCable(hit.properties.id);
      } else if (TERR_LAYERS.indexOf(layerId) !== -1) {
        pinTerr(hit.properties.fid, hit.properties);
      } else if (layerId === "stations") {
        var real = (LANDING_POINTS.features[hit.id] && LANDING_POINTS.features[hit.id].properties) || hit.properties;
        pinPoint(landingTooltipHTML(real));
      } else if (layerId === "cities") {
        pinPoint(cityTooltipHTML(hit.properties));
      }
    });

    buildSidebar();
    buildFooter();
    applyVisibility();

    // Layers sidebar collapses to a rail; state persists across sessions.
    var layoutLS = lsGet("fm_layout_v1") || {};
    var layersToggle = document.getElementById("layers-toggle");
    var sidebarBackdrop = document.getElementById("sidebar-backdrop");
    var sidebarCollapse;
    function syncSidebarMode() {
      var isMobile = mobileLayout.matches;
      layersToggle.hidden = !isMobile;
      if (!isMobile) {
        sidebarBackdrop.hidden = true;
        sidebar.removeAttribute("aria-hidden");
        sidebarCollapse.button.innerHTML = "&laquo;";
        sidebarCollapse.button.setAttribute("aria-label", "Collapse layers");
        sidebarCollapse.button.title = "Collapse";
      } else {
        var isOpen = !sidebarCollapse.get();
        sidebarBackdrop.hidden = !isOpen;
        sidebar.setAttribute("aria-hidden", isOpen ? "false" : "true");
        layersToggle.setAttribute("aria-expanded", isOpen ? "true" : "false");
        sidebarCollapse.button.innerHTML = "&times;";
        sidebarCollapse.button.setAttribute("aria-label", "Close layers");
        sidebarCollapse.button.title = "Close";
      }
    }
    sidebarCollapse = attachCollapse(sidebar, {
      label: "Layers",
      initial: mobileLayout.matches ? true : !!layoutLS.sidebar_collapsed,
      onChange: function (c) {
        if (!mobileLayout.matches) {
          layoutLS.sidebar_collapsed = c;
          lsSet("fm_layout_v1", layoutLS);
        }
        syncSidebarMode();
        if (mobileLayout.matches) {
          if (c) layersToggle.focus();
          else sidebarCollapse.button.focus();
        }
      },
      onSettle: function () { map.resize(); }
    });
    layersToggle.addEventListener("click", function () { sidebarCollapse.set(false); });
    sidebarBackdrop.addEventListener("click", function () { sidebarCollapse.set(true); });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && mobileLayout.matches && !sidebarCollapse.get()) sidebarCollapse.set(true);
    });
    function handleLayoutChange() {
      map.setMinZoom(mobileLayout.matches ? 1.5 : 2);
      sidebarCollapse.set(mobileLayout.matches ? true : !!layoutLS.sidebar_collapsed);
      syncSidebarMode();
      map.resize();
    }
    if (mobileLayout.addEventListener) mobileLayout.addEventListener("change", handleLayoutChange);
    else mobileLayout.addListener(handleLayoutChange);
    syncSidebarMode();

    // Extension hook: overlay modules (loaded after app.js) register callbacks on
    // window.__fmExt and get called once base layers + sidebar exist. A throwing
    // extension must not take down the base map. After init, the array is replaced
    // by an immediately-invoking object so an extension that registers late (or an
    // init that ran early, e.g. synchronous style load) still attaches.
    function runExt(fn) {
      try { fn(window.__fiberMap); } catch (e) { console.error("fiber-map extension failed:", e); }
    }
    var pending = window.__fmExt || [];
    window.__fmExt = { push: runExt };
    pending.forEach(runExt);
  }
  map.on("style.load", initMapContent);
  map.on("load", initMapContent);
  if (map.isStyleLoaded()) initMapContent(); // style already parsed before handlers attached

  // ================= sidebar UI =================
  var sidebar = document.getElementById("sidebar");

  function checkboxRow(opts) {
    // opts: { checked, label, onChange, swatchColor, dashed, badge, extraClass }
    var row = document.createElement("label");
    row.className = "chk" + (opts.extraClass ? " " + opts.extraClass : "");
    var input = document.createElement("input");
    input.type = "checkbox";
    input.checked = !!opts.checked;
    input.addEventListener("change", function () { opts.onChange(input.checked); });
    row.appendChild(input);
    if (opts.swatchColor) {
      var sw = document.createElement("span");
      sw.className = "swatch" + (opts.dashed ? " dashed" : "");
      sw.style.background = opts.dashed ? "" : opts.swatchColor;
      sw.style.color = opts.swatchColor; // dashed swatch uses currentColor
      row.appendChild(sw);
    }
    var lab = document.createElement("span");
    lab.className = "label";
    lab.textContent = opts.label;
    row.appendChild(lab);
    if (opts.badge) {
      var b = document.createElement("span");
      b.className = "badge";
      b.textContent = opts.badge;
      row.appendChild(b);
    }
    row._input = input;
    return row;
  }

  function section(title, hint) {
    var s = document.createElement("div");
    s.className = "section";
    var h = document.createElement("h2");
    h.textContent = title;
    if (hint) {
      var hs = document.createElement("span");
      hs.className = "hint";
      hs.textContent = " " + hint;
      h.appendChild(hs);
    }
    s.appendChild(h);
    return s;
  }

  function buildSidebar() {
    sidebar.innerHTML = "";

    var title = document.createElement("h1");
    title.textContent = "Africa Fiber Infrastructure";
    sidebar.appendChild(title);
    var sub = document.createElement("p");
    sub.className = "subtitle";
    sub.textContent = "Subsea cables, terrestrial backbone, landing stations & latency";
    sidebar.appendChild(sub);

    var nav = document.createElement("a");
    nav.className = "nav-link";
    nav.href = "countries.html";
    nav.textContent = "By-country table →";
    sidebar.appendChild(nav);

    var srcNav = document.createElement("a");
    srcNav.className = "nav-link-secondary";
    srcNav.href = "sources.html";
    srcNav.textContent = "Sources & assumptions →";
    sidebar.appendChild(srcNav);

    // 1. Status tiers
    var s1 = section("Status");
    [
      ["subsea_live", "Subsea — live"],
      ["subsea_planned", "Subsea — planned"],
      ["terr_live", "Terrestrial — live"],
      ["terr_planned", "Terrestrial — planned"]
    ].forEach(function (pair) {
      s1.appendChild(checkboxRow({
        checked: state.status[pair[0]],
        label: pair[1],
        onChange: function (v) { state.status[pair[0]] = v; applyVisibility(); }
      }));
    });
    sidebar.appendChild(s1);

    // 2. Terrestrial tiers
    var s2 = section("Terrestrial tiers", "(derived; access/metro fiber is sparsely mapped)");
    [
      ["core", "Core"],
      ["distribution", "Distribution"],
      ["access", "Access"]
    ].forEach(function (pair) {
      s2.appendChild(checkboxRow({
        checked: state.terrTier[pair[0]],
        label: pair[1],
        swatchColor: TERR_COLOR,
        onChange: function (v) { state.terrTier[pair[0]] = v; applyVisibility(); }
      }));
    });
    sidebar.appendChild(s2);

    // 3. Points
    var s3 = section("Points");
    s3.appendChild(checkboxRow({
      checked: state.points.landing, label: "Landing stations",
      onChange: function (v) { state.points.landing = v; applyVisibility(); }
    }));
    s3.appendChild(checkboxRow({
      checked: state.points.cities, label: "Cities",
      onChange: function (v) { state.points.cities = v; applyVisibility(); }
    }));
    sidebar.appendChild(s3);

    // 3b. Latency overlays — Starlink RTT row in city/station tooltips (est., default OFF).
    var s3b = section("Latency");
    s3b.appendChild(checkboxRow({
      checked: state.starlink, label: "Starlink RTT (est.)",
      onChange: function (v) { state.starlink = v; }
    }));
    sidebar.appendChild(s3b);

    // 4. Per-cable list
    var s4 = section("Cables", "(" + cableOrder.length + ")");
    var tools = document.createElement("div");
    tools.className = "cable-tools";
    var filter = document.createElement("input");
    filter.id = "cable-filter";
    filter.type = "search";
    filter.placeholder = "Filter cables…";
    var allBtn = document.createElement("button");
    allBtn.className = "linkbtn"; allBtn.textContent = "All";
    var noneBtn = document.createElement("button");
    noneBtn.className = "linkbtn selnone"; noneBtn.textContent = "None";
    tools.appendChild(filter);
    tools.appendChild(allBtn);
    tools.appendChild(noneBtn);
    s4.appendChild(tools);

    var list = document.createElement("div");
    list.id = "cable-list";
    s4.appendChild(list);
    var count = document.createElement("div");
    count.id = "cable-count";
    s4.appendChild(count);
    sidebar.appendChild(s4);

    var rowById = {};

    function renderList() {
      list.innerHTML = "";
      var q = filter.value.trim().toLowerCase();
      var shown = 0;
      cableOrder.forEach(function (id) {
        var name = cableName(id);
        if (q && name.toLowerCase().indexOf(q) === -1) return;
        shown++;
        var row = checkboxRow({
          checked: state.cableChecked[id],
          label: name,
          swatchColor: cableColor(id),
          dashed: cableIsPlanned(id),
          badge: cableIsPlanned(id) ? "planned" : null,
          onChange: function (v) { state.cableChecked[id] = v; applyVisibility(); }
        });
        rowById[id] = row._input;
        list.appendChild(row);
      });
      if (!shown) {
        var e = document.createElement("div");
        e.className = "empty-note";
        e.textContent = "No cables match “" + filter.value + "”";
        list.appendChild(e);
      }
      count.textContent = shown + " of " + cableOrder.length + " shown";
    }

    function setAll(v) {
      // Applies to the currently filtered (visible in list) cables.
      var q = filter.value.trim().toLowerCase();
      cableOrder.forEach(function (id) {
        if (q && cableName(id).toLowerCase().indexOf(q) === -1) return;
        state.cableChecked[id] = v;
        if (rowById[id]) rowById[id].checked = v;
      });
      applyVisibility();
    }

    filter.addEventListener("input", renderList);
    allBtn.addEventListener("click", function (e) { e.preventDefault(); setAll(true); });
    noneBtn.addEventListener("click", function (e) { e.preventDefault(); setAll(false); });
    renderList();
  }

  // ================= footer =================
  function buildFooter() {
    var f = document.getElementById("footer");
    var gen = window.DATA_GENERATED_UTC ? String(window.DATA_GENERATED_UTC) : "unknown";
    f.innerHTML = '<span class="footer-desktop">' +
      'Subsea: <a href="https://www.submarinecablemap.com" target="_blank" rel="noopener">TeleGeography submarinecablemap.com</a> (CC BY-SA) · ' +
      'Terrestrial & cities: AfTerFibre / NSRC (CC BY) · ' +
      'Basemap © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors, © <a href="https://carto.com/attributions" target="_blank" rel="noopener">CARTO</a>' +
      ' &nbsp;|&nbsp; <span class="est">Capacities, costs and latencies are estimates</span>' +
      ' &nbsp;|&nbsp; <span class="gen">Data generated: ' + esc(gen) + '</span></span>' +
      '<span class="footer-mobile"><a href="sources.html">Data sources</a> · © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> · © <a href="https://carto.com/attributions" target="_blank" rel="noopener">CARTO</a></span>';
  }
})();
