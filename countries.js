/* Africa Fiber — by-country metrics table.
 * Reads the same window.* data globals as the map (no Leaflet). Renders one
 * aggregate row per African landing country; the per-cable table is hidden
 * behind a click/keyboard-toggle accordion. Every lookup degrades to "n/a"
 * so missing annotations never throw. */
(function () {
  "use strict";

  var CABLES_META    = window.CABLES_META    || {};
  var LANDING_POINTS = window.LANDING_POINTS || { type: "FeatureCollection", features: [] };
  var ANN            = window.ANNOTATIONS    || {};
  var ANN_CABLES  = ANN.cables         || {};
  var ANN_REGIONS = ANN.regions        || {};
  var ANN_CR      = ANN.country_region || {};
  var ANN_LAT     = ANN.latency        || {};
  var ANN_SL      = ANN.starlink       || {};

  // Fallback region egress rates ($/Gbps/mo), used only if annotations.js
  // lacks cost_usd_gbps_mo on a region.
  var REGION_COST_FALLBACK = {
    west_africa: 3000,
    southern_africa: 2000,
    east_africa: 3000,
    north_africa: 1250
  };

  // ---------- helpers ----------
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  // Same slugify as the map (app.js): lowercase, strip accents, non-alnum -> '-'.
  function slugify(s) {
    return String(s || "")
      .toLowerCase()
      .normalize("NFD").replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  }
  function has(v) { return v != null && v !== ""; }
  function fmtNum(n) {
    return (Math.round(n * 100) / 100).toString();
  }
  function fmtUSD(n) { return Number(n).toLocaleString("en-US"); }
  function round5(n) { return Math.round(n / 5) * 5; }

  // Accent/spacing-insensitive index of country_region so "Côte d'Ivoire" and
  // "Réunion" resolve to the seed keys ("Cote d'Ivoire" / "Reunion").
  var CR_NORM = {};
  Object.keys(ANN_CR).forEach(function (k) { CR_NORM[slugify(k)] = ANN_CR[k]; });

  function regionKeyFor(country) {
    if (ANN_CR[country]) return ANN_CR[country];
    return CR_NORM[slugify(country)] || null;
  }
  function egressForCountry(country) {
    var key = regionKeyFor(country);
    if (!key) return null;
    var reg = ANN_REGIONS[key] || {};
    var cost = has(reg.cost_usd_gbps_mo) ? reg.cost_usd_gbps_mo : REGION_COST_FALLBACK[key];
    return has(cost) ? cost : null;
  }
  function egressHTML(country) {
    var egress = egressForCountry(country);
    return egress === null
      ? '<span class="na">n/a</span>'
      : '~$' + esc(fmtUSD(egress)) + '/Gbps·mo <span class="est">est.</span>';
  }

  // Estimated Starlink RTT for a country: local access median + fiber leg from the
  // nearest Starlink PoP (per ANN.starlink), rounded to 5 ms. North Africa routes via
  // European gateways. Returns null when the country is unmapped. Fiber sort is unaffected.
  function starlinkForCountry(country) {
    var region = regionKeyFor(country);
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

  function cableName(id) {
    var m = CABLES_META[id];
    return (m && m.name) || id;
  }

  // Minimum RTT per metric across a country's landing cities, with the city
  // that produced it (labels the source, e.g. "130 ms (Mombasa)").
  function latencyForCountry(cities) {
    var metrics = { europe_ms: null, us_east_ms: null, us_west_ms: null };
    var srcCity = { europe_ms: null, us_east_ms: null, us_west_ms: null };
    cities.forEach(function (city) {
      var l = ANN_LAT[slugify(city)];
      if (!l) return;
      Object.keys(metrics).forEach(function (m) {
        if (has(l[m]) && (metrics[m] === null || l[m] < metrics[m])) {
          metrics[m] = l[m];
          srcCity[m] = city;
        }
      });
    });
    return { val: metrics, city: srcCity };
  }
  function latencyCell(lat, metric, country) {
    var v = lat.val[metric];
    var base = v === null
      ? '<span class="na">n/a</span>'
      : '<span class="num">' + esc(fmtNum(v)) + ' ms</span>' +
        ' <span class="city-tag">(' + esc(lat.city[metric]) + ')</span>';
    // Starlink sub-line is always rendered (when data exists) and shown/hidden via the
    // body.sl-on class from the toolbar toggle — sorting stays on the fiber value only.
    var sl = country != null ? starlinkForCountry(country) : null;
    if (sl && sl[metric] != null) {
      base += '<span class="sl-line">SL ~' + esc(sl[metric]) + '</span>';
    }
    return base;
  }

  // ---------- build the model ----------
  var byCountry = {};
  LANDING_POINTS.features.forEach(function (f) {
    var p = f.properties || {};
    if (!has(p.country)) return;
    var c = byCountry[p.country] || (byCountry[p.country] = { cities: [], cables: [] });
    if (has(p.city) && c.cities.indexOf(p.city) === -1) c.cities.push(p.city);
    (p.cables || []).forEach(function (id) {
      if (c.cables.indexOf(id) === -1) c.cables.push(id);
    });
  });
  var countries = Object.keys(byCountry).sort(function (a, b) {
    return a.localeCompare(b);
  });

  // ---------- render ----------
  var sectionsEl = document.getElementById("sections");
  var filterEl = document.getElementById("filter");
  var countEl = document.getElementById("count");

  var totalCountries = 0, totalRows = 0, idx = 0;
  var html = [];

  // column-label header, aligned to the aggregate-row grid. Each label is a
  // real button so the aggregate rows can be sorted by that column.
  function sortHeader(key, label, extraClass) {
    return '<button class="sort-btn' + (extraClass ? ' ' + extraClass : '') + '"' +
             ' type="button" data-key="' + key + '">' +
             '<span class="sort-label">' + label + '</span>' +
             '<span class="sort-arrow" aria-hidden="true"></span>' +
           '</button>';
  }
  html.push(
    '<div class="agg-head agg-grid" role="row">' +
      sortHeader("country", "Country", "col-country") +
      sortHeader("cables", "Cables") +
      sortHeader("cap", "Total capacity") +
      sortHeader("egress", "Egress rate ($/Gbps·mo)") +
      sortHeader("rtt_eu", "RTT Europe") +
      sortHeader("rtt_ue", "RTT US&nbsp;East") +
      sortHeader("rtt_uw", "RTT US&nbsp;West") +
    '</div>'
  );

  countries.forEach(function (country) {
    var info = byCountry[country];
    var cables = info.cables.slice().sort(function (a, b) {
      return cableName(a).toLowerCase().localeCompare(cableName(b).toLowerCase());
    });
    if (!cables.length) return;
    totalCountries++;
    idx++;
    var detailId = "detail-" + idx;

    var eg = egressHTML(country);
    var egVal = egressForCountry(country);
    var lat = latencyForCountry(info.cities);

    var live = 0, planned = 0, capSum = 0, capKnown = 0;
    var rowsHtml = [];
    cables.forEach(function (id) {
      totalRows++;
      var meta = CABLES_META[id] || {};
      var isPlanned = !!meta.is_planned;
      if (isPlanned) planned++; else live++;

      var ann = ANN_CABLES[id] || {};
      var cap = has(ann.capacity_tbps) ? ann.capacity_tbps : null;
      if (cap !== null) { capSum += cap; capKnown++; }

      var nameHtml = '<span class="cable-name">' + esc(cableName(id)) + '</span>';
      if (isPlanned) nameHtml += '<span class="badge planned">Planned</span>';
      if (has(meta.rfs_year)) nameHtml += '<span class="rfs">RFS ' + esc(meta.rfs_year) + '</span>';

      var capCell = cap === null
        ? '<span class="na">n/a</span>'
        : '<span class="num">' + esc(fmtNum(cap)) + ' Tbps</span>';

      rowsHtml.push(
        '<tr data-cable="' + esc(cableName(id).toLowerCase()) + '">' +
          '<td data-label="Cable">' + nameHtml + '</td>' +
          '<td data-label="Capacity">' + capCell + '</td>' +
          '<td data-label="Egress rate">' + eg + '</td>' +
          '<td data-label="RTT Europe">' + latencyCell(lat, "europe_ms", country) + '</td>' +
          '<td data-label="RTT US East">' + latencyCell(lat, "us_east_ms", country) + '</td>' +
          '<td data-label="RTT US West">' + latencyCell(lat, "us_west_ms", country) + '</td>' +
        '</tr>'
      );
    });

    var capAgg = capKnown
      ? '<span class="num">' + esc(fmtNum(capSum)) + ' Tbps</span>'
      : '<span class="na">n/a</span>';
    var cablesAgg = '<b>' + cables.length + '</b> (' + live + ' live, ' + planned + ' planned)';

    function sattr(v) { return v === null || v === undefined ? "" : v; }
    html.push(
      '<section class="country" data-country="' + esc(country.toLowerCase()) + '"' +
        ' data-cables="' + cables.length + '"' +
        ' data-cap="' + sattr(capKnown ? capSum : null) + '"' +
        ' data-egress="' + sattr(egVal) + '"' +
        ' data-rtt_eu="' + sattr(lat.val.europe_ms) + '"' +
        ' data-rtt_ue="' + sattr(lat.val.us_east_ms) + '"' +
        ' data-rtt_uw="' + sattr(lat.val.us_west_ms) + '">' +
        '<button class="agg-row agg-grid" type="button" aria-expanded="false" ' +
                'aria-controls="' + detailId + '">' +
          '<span class="col-country"><span class="chev" aria-hidden="true">&rsaquo;</span>' +
            '<span class="country-name">' + esc(country) + '</span></span>' +
          '<span class="agg-cables" data-label="Cables">' + cablesAgg + '</span>' +
          '<span class="agg-cap" data-label="Capacity">' + capAgg + '</span>' +
          '<span class="agg-egress" data-label="Egress rate">' + eg + '</span>' +
          '<span class="agg-lat" data-label="RTT Europe">' + latencyCell(lat, "europe_ms", country) + '</span>' +
          '<span class="agg-lat" data-label="RTT US East">' + latencyCell(lat, "us_east_ms", country) + '</span>' +
          '<span class="agg-lat" data-label="RTT US West">' + latencyCell(lat, "us_west_ms", country) + '</span>' +
        '</button>' +
        '<div class="detail" id="' + detailId + '" hidden>' +
          '<table>' +
            '<thead><tr>' +
              '<th>Cable</th><th>Capacity</th><th>Egress rate</th>' +
              '<th>RTT Europe</th><th>RTT US&nbsp;East</th><th>RTT US&nbsp;West</th>' +
            '</tr></thead>' +
            '<tbody>' + rowsHtml.join("") + '</tbody>' +
          '</table>' +
        '</div>' +
      '</section>'
    );
  });

  sectionsEl.innerHTML = html.join("") +
    '<div class="empty" id="empty" hidden>No countries or cables match your filter.</div>';
  countEl.textContent = totalCountries + " countries · " + totalRows + " cable landings";

  // ---------- accordion ----------
  var sections = Array.prototype.slice.call(sectionsEl.querySelectorAll(".country"));
  var emptyEl = document.getElementById("empty");

  function setExpanded(sec, open) {
    var btn = sec.querySelector(".agg-row");
    var detail = sec.querySelector(".detail");
    btn.setAttribute("aria-expanded", open ? "true" : "false");
    detail.hidden = !open;
  }
  sections.forEach(function (sec) {
    sec.querySelector(".agg-row").addEventListener("click", function () {
      var open = this.getAttribute("aria-expanded") === "true";
      setExpanded(sec, !open);
    });
  });

  // ---------- expand / collapse all ----------
  function setAll(open) {
    sections.forEach(function (sec) {
      if (sec.hidden) return;       // only touch what's currently visible
      setExpanded(sec, open);
    });
  }
  document.getElementById("expand-all")
    .addEventListener("click", function () { setAll(true); });
  document.getElementById("collapse-all")
    .addEventListener("click", function () { setAll(false); });

  // ---------- sorting ----------
  // Sort by reordering the .country nodes in place, which preserves each
  // section's expanded state, event listeners and (for filtering) its rows.
  var sortState = { key: "country", dir: "asc" };
  var headBtns = Array.prototype.slice.call(
    sectionsEl.querySelectorAll(".agg-head .sort-btn"));

  function sortValue(sec, key) {
    if (key === "country") return sec.getAttribute("data-country");
    var raw = sec.getAttribute("data-" + key);
    if (raw === "" || raw == null) return null;
    var n = parseFloat(raw);
    return isNaN(n) ? null : n;
  }
  function compareSecs(a, b) {
    var key = sortState.key, dir = sortState.dir === "desc" ? -1 : 1;
    var va = sortValue(a, key), vb = sortValue(b, key);
    var ma = va === null, mb = vb === null;
    if (ma && mb) return 0;
    if (ma) return 1;   // missing always sorts to the END, both directions
    if (mb) return -1;
    var cmp = key === "country" ? va.localeCompare(vb) : va - vb;
    return cmp * dir;
  }
  function updateSortHeaders() {
    headBtns.forEach(function (btn) {
      var arrow = btn.querySelector(".sort-arrow");
      if (btn.getAttribute("data-key") === sortState.key) {
        btn.classList.add("active");
        btn.setAttribute("aria-sort",
          sortState.dir === "desc" ? "descending" : "ascending");
        arrow.textContent = sortState.dir === "desc" ? "▼" : "▲";
      } else {
        btn.classList.remove("active");
        btn.removeAttribute("aria-sort");
        arrow.textContent = "↕";
      }
    });
  }
  function applySort() {
    sections.slice().sort(compareSecs).forEach(function (sec) {
      sectionsEl.appendChild(sec);
    });
    sectionsEl.appendChild(emptyEl);   // keep the empty message last
    updateSortHeaders();
  }
  headBtns.forEach(function (btn) {
    btn.addEventListener("click", function () {
      var key = btn.getAttribute("data-key");
      if (sortState.key === key) {
        sortState.dir = sortState.dir === "asc" ? "desc" : "asc";
      } else {
        sortState.key = key;
        sortState.dir = "asc";
      }
      applySort();
    });
  });
  updateSortHeaders();   // reflect the default (Country ascending)

  // ---------- filter ----------
  function applyFilter() {
    var q = filterEl.value.trim().toLowerCase();
    var anyShown = false;
    sections.forEach(function (sec) {
      var rows = sec.querySelectorAll("tbody tr");
      if (!q) {
        // reset: show every section, all rows, collapsed
        Array.prototype.forEach.call(rows, function (tr) { tr.hidden = false; });
        sec.hidden = false;
        setExpanded(sec, false);
        anyShown = true;
        return;
      }
      var countryMatch = sec.getAttribute("data-country").indexOf(q) !== -1;
      if (countryMatch) {
        // whole-country match: show aggregate, keep rows available, collapsed
        Array.prototype.forEach.call(rows, function (tr) { tr.hidden = false; });
        sec.hidden = false;
        setExpanded(sec, false);
        anyShown = true;
        return;
      }
      // otherwise match by cable name; auto-expand the matching country
      var shown = 0;
      Array.prototype.forEach.call(rows, function (tr) {
        var vis = tr.getAttribute("data-cable").indexOf(q) !== -1;
        tr.hidden = !vis;
        if (vis) shown++;
      });
      sec.hidden = shown === 0;
      setExpanded(sec, shown > 0);
      if (shown > 0) anyShown = true;
    });
    emptyEl.hidden = anyShown;
  }

  filterEl.addEventListener("input", applyFilter);

  // ---------- Starlink RTT toggle ----------
  // The SL sub-lines are pre-rendered in every RTT cell and revealed by toggling the
  // body.sl-on class, so no re-render is needed and sorting stays on fiber values.
  var slToggle = document.getElementById("starlink-toggle");
  if (slToggle) {
    slToggle.addEventListener("change", function () {
      document.body.classList.toggle("sl-on", slToggle.checked);
    });
  }
})();
