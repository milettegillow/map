(function () {
  'use strict';

  /* ------------------------------------------------------------ constants */

  // Oxblood for my own map, olive for the group map, so the two never read as
  // the same data. Both are keyed 1-4, deepest last.
  const MINE_DEPTH = { 1: '#d49a87', 2: '#b8675a', 3: '#8f3a2f', 4: '#6b1d18' };
  const GROUP_DEPTH = { 1: '#c2c48f', 2: '#959d5c', 3: '#66733a', 4: '#3c4a22' };
  const PARCHMENT = '#f2e8d0';
  const GOLD = '#c9a24a';
  const WORLD_URL = 'https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/countries-50m.json';
  const THIS_YEAR = new Date().getFullYear();
  const EARLIEST_BIRTH_YEAR = 1900;
  const MAX_SEARCH_ZOOM = 24;
  const MAX_SEARCH_RESULTS = 50;

  // Countries whose map-data name is not what we want to show. The key on the
  // left is what stays in the database, in sovereign.js and in the map data —
  // only the label changes, so rows saved before this existed still match.
  const DISPLAY_NAMES = {
    'Czechia': 'Czech Republic'
  };

  const STORED_NAMES = {};
  Object.keys(DISPLAY_NAMES).forEach((key) => {
    STORED_NAMES[DISPLAY_NAMES[key].toLowerCase()] = key;
  });

  function displayName(key) {
    return DISPLAY_NAMES[key] || key;
  }

  // The reverse: takes whatever someone typed and gives back the stored key.
  function storedName(text) {
    const trimmed = text.trim();
    return STORED_NAMES[trimmed.toLowerCase()] || trimmed;
  }

  // countries-50m files the French overseas departments inside the France
  // MultiPolygon, so they cannot be scratched on their own. Each box below is
  // matched against a polygon's centroid to pull it out as its own place.
  const OVERSEAS = [
    { name: 'French Guiana', west: -55,  east: -51,   south: 2,     north: 6 },
    { name: 'Réunion',       west: 55,   east: 56,    south: -21.5, north: -20.8 },
    { name: 'Mayotte',       west: 44.9, east: 45.4,  south: -13.1, north: -12.5 },
    { name: 'Guadeloupe',    west: -61.9, east: -61,  south: 15.8,  north: 16.6 },
    { name: 'Martinique',    west: -61.3, east: -60.8, south: 14.3, north: 14.9 }
  ];

  // Only these count towards the tally. Everything else on the map — Greenland,
  // Taiwan, Kosovo and the rest — can still be scratched, it just does not count.
  const SOVEREIGN = new Set(
    typeof SOVEREIGN_COUNTRIES === 'undefined' ? [] : SOVEREIGN_COUNTRIES
  );
  const SOVEREIGN_TOTAL = SOVEREIGN.size;

  const client = supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });

  /* ---------------------------------------------------------------- state */

  const state = {
    user: null,
    profile: null,
    visits: new Map(),        // country -> { visit_count, first_year }
    stats: new Map(),         // country -> { visitors, mean_visits, mean_age }
    travellers: 0,
    maxVisitors: 0,
    mode: 'mine',
    selected: null,
    features: [],
    names: [],
    byName: new Map(),
    size: { w: 960, h: 500 },
    handledUser: null
  };

  /* -------------------------------------------------------------- elements */

  const $ = (id) => document.getElementById(id);

  const screens = {
    loading: $('screen-loading'),
    auth: $('screen-auth'),
    profile: $('screen-profile'),
    app: $('screen-app')
  };

  const authForm = $('auth-form');
  const authEmail = $('auth-email');
  const authSend = $('auth-send');
  const authSent = $('auth-sent');
  const authSentLine = $('auth-sent-line');
  const authAgain = $('auth-again');

  const profileForm = $('profile-form');
  const birthYear = $('birth-year');
  const birthCountry = $('birth-country');

  const frame = $('frame');
  const legend = $('legend');
  const legendItems = Array.prototype.slice.call(legend.children);
  const modeMine = $('mode-mine');
  const modeGroup = $('mode-group');

  const panel = $('panel');
  const panelTitle = $('panel-title');
  const panelMine = $('panel-mine');
  const panelGroup = $('panel-group');
  const visitButtons = $('visit-buttons');
  const yearInput = $('year-input');
  const tally = $('tally');
  const groupVisitors = $('group-visitors');
  const groupVisits = $('group-visits');
  const groupAge = $('group-age');

  birthYear.min = EARLIEST_BIRTH_YEAR;
  birthYear.max = THIS_YEAR;

  function show(name) {
    Object.keys(screens).forEach((k) => { screens[k].hidden = k !== name; });
  }

  /* ------------------------------------------------------------------ map */

  const svg = d3.select('#map');
  const defs = svg.append('defs');
  const gZoom = svg.append('g');
  const spherePath = gZoom.append('path').attr('class', 'sphere');
  const gCountries = gZoom.append('g');
  const gFx = gZoom.append('g').attr('pointer-events', 'none');

  const projection = d3.geoNaturalEarth1();
  const geoPath = d3.geoPath(projection);
  let zoom = null;
  let clipSeq = 0;

  function zoneFor(coordinates) {
    const centre = d3.geoCentroid({ type: 'Polygon', coordinates: coordinates });
    const lon = centre[0];
    const lat = centre[1];
    return OVERSEAS.find((zone) =>
      lon >= zone.west && lon <= zone.east && lat >= zone.south && lat <= zone.north
    );
  }

  function polygonsOf(geometry) {
    if (!geometry) return [];
    return geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  }

  // Whatever matches no box stays France — the mainland, Corsica and the
  // Atlantic islands. A department that already has its own feature in the data
  // is merged into it rather than added a second time.
  function splitOverseas(features) {
    const france = features.find((f) => f.properties.name === 'France');
    if (!france || france.geometry.type !== 'MultiPolygon') return features;

    const kept = [];
    const pulled = new Map();

    france.geometry.coordinates.forEach((coordinates) => {
      const zone = zoneFor(coordinates);
      if (!zone) {
        kept.push(coordinates);
        return;
      }
      if (!pulled.has(zone.name)) pulled.set(zone.name, []);
      pulled.get(zone.name).push(coordinates);
    });

    if (!pulled.size || !kept.length) return features;

    france.geometry = { type: 'MultiPolygon', coordinates: kept };

    const result = features.slice();
    pulled.forEach((coordinates, name) => {
      const existing = result.find((f) => f.properties.name === name);
      if (existing) {
        existing.geometry = {
          type: 'MultiPolygon',
          coordinates: polygonsOf(existing.geometry).concat(coordinates)
        };
        return;
      }
      result.push({
        type: 'Feature',
        properties: { name: name },
        geometry: { type: 'MultiPolygon', coordinates: coordinates }
      });
    });
    return result;
  }

  async function loadWorld() {
    const topo = await d3.json(WORLD_URL);
    const collection = topojson.feature(topo, topo.objects.countries);
    const named = collection.features.filter((f) => f.properties && f.properties.name);
    state.features = splitOverseas(named);
    state.byName = new Map(state.features.map((f) => [f.properties.name, f]));
    state.names = state.features
      .map((f) => f.properties.name)
      .sort((a, b) => a.localeCompare(b));

    const unmatched = SOVEREIGN_TOTAL
      ? SOVEREIGN_COUNTRIES.filter((name) => !state.byName.has(name))
      : [];
    if (unmatched.length) {
      console.warn(
        'Sovereign countries with no feature in countries-50m, so they cannot be ' +
        'scratched or counted: ' + unmatched.join(', ')
      );
    }
  }

  function buildMap() {
    zoom = d3.zoom()
      .scaleExtent([1, 60])
      .on('zoom', (event) => gZoom.attr('transform', event.transform));

    svg.call(zoom).on('dblclick.zoom', null);

    gCountries.selectAll('path')
      .data(state.features, (d) => d.properties.name)
      .join('path')
      .attr('class', 'country')
      .on('click', (event, d) => selectCountry(d.properties.name));

    sizeMap();
    new ResizeObserver(() => {
      clearTimeout(sizeMap.timer);
      sizeMap.timer = setTimeout(sizeMap, 120);
    }).observe(frame);
  }

  function sizeMap() {
    const rect = frame.getBoundingClientRect();
    const w = Math.round(rect.width);
    const h = Math.round(rect.height);
    if (w < 2 || h < 2) return;

    state.size = { w: w, h: h };
    svg.attr('viewBox', '0 0 ' + w + ' ' + h);
    projection.fitExtent([[14, 14], [w - 14, h - 14]], { type: 'Sphere' });
    spherePath.attr('d', geoPath({ type: 'Sphere' }));
    gCountries.selectAll('path').attr('d', geoPath);

    if (zoom) {
      zoom.extent([[0, 0], [w, h]]).translateExtent([[0, 0], [w, h]]);
    }
  }

  function fillFor(name) {
    if (state.mode === 'mine') {
      const v = state.visits.get(name);
      return v ? MINE_DEPTH[v.visit_count] : PARCHMENT;
    }
    const s = state.stats.get(name);
    if (!s || !s.visitors) return PARCHMENT;
    const max = state.maxVisitors || 1;
    const bucket = Math.min(4, Math.max(1, Math.ceil((s.visitors / max) * 4)));
    return GROUP_DEPTH[bucket];
  }

  function paint() {
    gCountries.selectAll('path').style('fill', (d) => fillFor(d.properties.name));
  }

  function countryNode(name) {
    return gCountries.selectAll('path').filter((d) => d.properties.name === name);
  }

  function paintCountry(name) {
    countryNode(name).style('fill', fillFor(name));
  }

  function scratchReveal(name) {
    const feature = state.byName.get(name);
    const node = countryNode(name);
    if (!feature || node.empty()) return;

    const b = geoPath.bounds(feature);
    const pad = 2;
    const x = b[0][0] - pad;
    const y = b[0][1] - pad;
    const w = (b[1][0] - b[0][0]) + pad * 2;
    const h = (b[1][1] - b[0][1]) + pad * 2;
    const id = 'scratch-' + (++clipSeq);

    const rect = defs.append('clipPath')
      .attr('id', id)
      .attr('clipPathUnits', 'userSpaceOnUse')
      .append('rect')
      .attr('x', x).attr('y', y).attr('height', h).attr('width', 0);

    node.attr('clip-path', 'url(#' + id + ')');

    const shimmer = gFx.append('path')
      .attr('d', geoPath(feature))
      .attr('fill', GOLD)
      .attr('opacity', 0.9)
      .attr('clip-path', 'url(#' + id + ')');

    shimmer.transition().duration(520).ease(d3.easeCubicOut)
      .attr('opacity', 0)
      .remove();

    rect.transition().duration(500).ease(d3.easeCubicOut)
      .attr('width', w)
      .on('end interrupt', () => {
        if (node.attr('clip-path') === 'url(#' + id + ')') node.attr('clip-path', null);
        defs.select('#' + id).remove();
      });
  }

  // The biggest polygon of a multi-part feature, used when a country is cut in
  // two by the antimeridian (Fiji, the United States) — the whole feature then
  // measures a full 360 degrees wide and would not zoom at all.
  function largestPart(feature) {
    const geometry = feature.geometry;
    if (!geometry || geometry.type !== 'MultiPolygon') return feature;

    let best = feature;
    let bestArea = -1;
    geometry.coordinates.forEach((coordinates) => {
      const polygon = { type: 'Polygon', coordinates: coordinates };
      const area = d3.geoArea(polygon);
      if (area > bestArea) {
        bestArea = area;
        best = polygon;
      }
    });
    return best;
  }

  function lonSpan(bounds) {
    const span = bounds[1][0] - bounds[0][0];
    return span < 0 ? span + 360 : span;
  }

  // Projected bounds break down for anything near the antimeridian — Russia
  // comes out as wide as the whole map — so size the zoom from the spherical
  // extent instead and centre on the spherical centroid.
  function zoomToCountry(name) {
    const feature = state.byName.get(name);
    if (!feature || !zoom) return;

    const w = state.size.w;
    const h = state.size.h;
    const sphere = geoPath.bounds({ type: 'Sphere' });
    const worldW = sphere[1][0] - sphere[0][0];
    const worldH = sphere[1][1] - sphere[0][1];

    let target = feature;
    let b = d3.geoBounds(target);
    let spanLon = lonSpan(b);

    if (spanLon > 350) {
      target = largestPart(feature);
      b = d3.geoBounds(target);
      spanLon = lonSpan(b);
    }

    const spanLat = Math.abs(b[1][1] - b[0][1]);

    const wide = Math.max((spanLon / 360) * worldW, 1) / w;
    const tall = Math.max((spanLat / 180) * worldH, 1) / h;
    const k = Math.max(1, Math.min(MAX_SEARCH_ZOOM, 0.55 / Math.max(wide, tall)));

    const centre = projection(d3.geoCentroid(target));
    if (!centre) return;

    svg.transition().duration(750).ease(d3.easeCubicInOut).call(
      zoom.transform,
      d3.zoomIdentity.translate(w / 2, h / 2).scale(k).translate(-centre[0], -centre[1])
    );
  }

  $('zoom-in').addEventListener('click', () => {
    if (zoom) svg.transition().duration(300).call(zoom.scaleBy, 1.7);
  });

  $('zoom-out').addEventListener('click', () => {
    if (zoom) svg.transition().duration(300).call(zoom.scaleBy, 1 / 1.7);
  });

  $('whole-world').addEventListener('click', () => {
    if (zoom) svg.transition().duration(500).call(zoom.transform, d3.zoomIdentity);
  });

  /* ---------------------------------------------------------------- panel */

  function selectCountry(name) {
    state.selected = name;

    const all = gCountries.selectAll('path');
    all.classed('is-selected', false).classed('is-pulsing', false);

    const node = countryNode(name);
    if (!node.empty()) {
      // Raise it so neighbouring outlines cannot paint over the gold edge.
      node.raise().classed('is-selected', true);
      node.node().getBoundingClientRect();   // restart the pulse animation
      node.classed('is-pulsing', true);
    }

    renderPanel();
    panel.hidden = false;
  }

  function closePanel() {
    panel.hidden = true;
    state.selected = null;
    gCountries.selectAll('path')
      .classed('is-selected', false)
      .classed('is-pulsing', false);
  }

  function oneDecimal(value) {
    if (value === null || value === undefined) return '—';
    const n = Number(value);
    if (!isFinite(n)) return '—';
    const r = Math.round(n * 10) / 10;
    return r % 1 === 0 ? String(r) : r.toFixed(1);
  }

  function renderPanel() {
    const name = state.selected;
    if (!name) return;
    panelTitle.textContent = displayName(name);

    if (state.mode === 'mine') {
      panelMine.hidden = false;
      panelGroup.hidden = true;

      const v = state.visits.get(name);
      const count = v ? v.visit_count : 0;
      Array.prototype.forEach.call(visitButtons.children, (btn) => {
        btn.classList.toggle('is-active', Number(btn.dataset.visits) === count);
      });

      yearInput.disabled = !v;
      yearInput.value = v && v.first_year ? String(v.first_year) : '';
      if (!v || v.first_year) yearInput.classList.remove('wants-year');
      return;
    }

    panelMine.hidden = true;
    panelGroup.hidden = false;

    const s = state.stats.get(name);
    const visitors = s ? Number(s.visitors) : 0;
    groupVisitors.textContent = visitors + ' of ' + state.travellers + ' have been here';
    groupVisits.textContent = 'Average visits: ' + (visitors ? oneDecimal(s.mean_visits) : '—');
    groupAge.textContent = 'Average age on first visit: ' +
      (s && s.mean_age !== null && s.mean_age !== undefined ? oneDecimal(s.mean_age) : '—');
  }

  visitButtons.addEventListener('click', (event) => {
    const btn = event.target.closest('button[data-visits]');
    if (!btn || !state.selected || state.mode !== 'mine') return;

    const name = state.selected;
    const next = Number(btn.dataset.visits);
    const previous = state.visits.get(name);
    const previousCount = previous ? previous.visit_count : 0;
    if (next === previousCount) return;

    if (next === 0) {
      state.visits.delete(name);
    } else {
      state.visits.set(name, {
        visit_count: next,
        first_year: previous ? previous.first_year : null
      });
    }

    renderPanel();
    paintCountry(name);
    updateTally();
    if (previousCount === 0 && next > 0) {
      scratchReveal(name);
      if (!yearInput.value) {
        yearInput.classList.add('wants-year');
        yearInput.focus();
      }
    }
    persistVisit(name);
  });

  let yearTimer = null;

  function commitYear(revertIfInvalid) {
    const name = state.selected;
    const v = name ? state.visits.get(name) : null;
    if (!v) return;

    const raw = yearInput.value.trim();

    if (raw === '') {
      if (v.first_year !== null) {
        v.first_year = null;
        persistVisit(name);
      }
      yearInput.classList.add('wants-year');
      return;
    }

    const n = Number(raw);
    const valid = /^\d{4}$/.test(raw) &&
      n >= state.profile.birth_year &&
      n <= THIS_YEAR;

    if (!valid) {
      if (revertIfInvalid) yearInput.value = v.first_year ? String(v.first_year) : '';
      return;
    }

    yearInput.classList.remove('wants-year');
    if (v.first_year !== n) {
      v.first_year = n;
      persistVisit(name);
    }
  }

  yearInput.addEventListener('input', () => {
    clearTimeout(yearTimer);
    yearTimer = setTimeout(() => commitYear(false), 450);
  });

  yearInput.addEventListener('blur', () => {
    clearTimeout(yearTimer);
    commitYear(true);
  });

  $('panel-close').addEventListener('click', closePanel);

  /* ------------------------------------------------------------ persistence */

  async function persistVisit(name) {
    if (!state.user) return;
    const v = state.visits.get(name);
    try {
      if (!v) {
        await client.from('visits').delete()
          .eq('user_id', state.user.id)
          .eq('country', name);
      } else {
        await client.from('visits').upsert({
          user_id: state.user.id,
          country: name,
          visit_count: v.visit_count,
          first_year: v.first_year,
          updated_at: new Date().toISOString()
        });
      }
    } catch (err) {
      console.error(err);
    }
  }

  async function loadVisits() {
    const res = await client.from('visits').select('country,visit_count,first_year');
    const rows = res.data || [];
    state.visits = new Map(rows.map((r) => [
      r.country,
      { visit_count: r.visit_count, first_year: r.first_year }
    ]));
  }

  async function loadGroup() {
    const [stats, count] = await Promise.all([
      client.rpc('group_stats'),
      client.rpc('traveller_count')
    ]);

    const rows = stats.data || [];
    state.stats = new Map(rows.map((r) => [r.country, {
      visitors: Number(r.visitors),
      mean_visits: r.mean_visits,
      mean_age: r.mean_age
    }]));
    state.maxVisitors = rows.reduce((m, r) => Math.max(m, Number(r.visitors)), 0);
    state.travellers = Number(count.data) || 0;
  }

  /* ---------------------------------------------------------------- legend */

  // My map counts visits, so the swatches are labelled 1 to 4+. The group map
  // buckets countries against the busiest one, so a bucket stands for a range
  // of visitor counts; a range nobody falls into is left out.
  function updateLegend() {
    const mine = state.mode === 'mine';
    const scale = mine ? MINE_DEPTH : GROUP_DEPTH;
    const max = state.maxVisitors;
    let shown = 0;

    legendItems.forEach((item, index) => {
      const bucket = index + 1;
      item.querySelector('i').style.background = scale[bucket];
      const label = item.querySelector('span');

      if (mine) {
        label.textContent = bucket === 4 ? '4+' : String(bucket);
        item.hidden = false;
        shown += 1;
        return;
      }

      const lowest = Math.floor(((bucket - 1) * max) / 4) + 1;
      const highest = Math.floor((bucket * max) / 4);
      if (lowest > highest) {
        item.hidden = true;
        return;
      }
      label.textContent = lowest === highest ? String(lowest) : lowest + '\u2013' + highest;
      item.hidden = false;
      shown += 1;
    });

    legend.hidden = shown === 0;
  }

  /* ----------------------------------------------------------------- tally */

  function percentOfWorld(count) {
    return SOVEREIGN_TOTAL ? Math.round((count / SOVEREIGN_TOTAL) * 100) : 0;
  }

  function updateTally() {
    if (state.mode === 'mine') {
      let visited = 0;
      state.visits.forEach((value, name) => {
        if (SOVEREIGN.has(name)) visited += 1;
      });
      tally.textContent = visited + ' of ' + SOVEREIGN_TOTAL + ' countries · ' +
        percentOfWorld(visited) + '%';
      return;
    }

    let visits = 0;
    state.stats.forEach((stat, name) => {
      if (SOVEREIGN.has(name)) visits += stat.visitors;
    });
    const average = state.travellers ? visits / state.travellers : 0;
    tally.textContent = state.travellers +
      (state.travellers === 1 ? ' traveller' : ' travellers') +
      ' · on average ' + Math.round(average) + ' of ' + SOVEREIGN_TOTAL +
      ' countries · ' + percentOfWorld(average) + '%';
  }

  /* ----------------------------------------------------------------- modes */

  async function setMode(mode) {
    state.mode = mode;
    modeMine.classList.toggle('is-active', mode === 'mine');
    modeGroup.classList.toggle('is-active', mode === 'group');

    if (mode === 'group') await loadGroup();
    paint();
    updateLegend();
    updateTally();
    if (state.selected) renderPanel();
  }

  modeMine.addEventListener('click', () => setMode('mine'));
  modeGroup.addEventListener('click', () => setMode('group'));

  /* ------------------------------------------------------------------- csv */

  function csvCell(value) {
    const s = String(value);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function downloadCsv() {
    const rows = [['country', 'visits', 'first_visited']];
    state.names
      .slice()
      .sort((a, b) => displayName(a).localeCompare(displayName(b)))
      .forEach((name) => {
        const v = state.visits.get(name);
        const visits = v ? (v.visit_count === 4 ? '4+' : String(v.visit_count)) : '0';
        const year = v && v.first_year ? String(v.first_year) : '';
        rows.push([displayName(name), visits, year]);
      });

    const csv = rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'my-scratch-map.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  $('csv-btn').addEventListener('click', downloadCsv);

  /* ------------------------------------------------------------- typeahead */

  function typeahead(input, list, getItems, onPick) {
    let items = [];
    let index = -1;

    function close() {
      list.hidden = true;
      list.innerHTML = '';
      index = -1;
      input.setAttribute('aria-expanded', 'false');
    }

    function highlight() {
      Array.prototype.forEach.call(list.children, (li, i) => {
        li.classList.toggle('is-active', i === index);
        if (i === index) li.scrollIntoView({ block: 'nearest' });
      });
    }

    function pick(i) {
      const name = items[i];
      if (name === undefined) return;
      input.value = displayName(name);
      close();
      onPick(name);
    }

    // Match on the stored name or the shown one, so "Czech" and "Czechia" both
    // reach the Czech Republic.
    function hit(name, term) {
      return Math.min(
        indexOrFar(name, term),
        indexOrFar(displayName(name), term)
      );
    }

    function indexOrFar(text, term) {
      const at = text.toLowerCase().indexOf(term);
      return at === -1 ? Infinity : at;
    }

    function open() {
      const term = input.value.trim().toLowerCase();
      if (!term) return close();

      items = getItems()
        .filter((n) => hit(n, term) !== Infinity)
        .sort((a, b) => {
          const sa = hit(a, term) === 0 ? 0 : 1;
          const sb = hit(b, term) === 0 ? 0 : 1;
          return sa - sb || displayName(a).localeCompare(displayName(b));
        })
        .slice(0, MAX_SEARCH_RESULTS);

      if (!items.length) return close();

      list.innerHTML = '';
      items.forEach((name, i) => {
        const li = document.createElement('li');
        li.textContent = displayName(name);
        li.addEventListener('mousedown', (event) => {
          event.preventDefault();
          pick(i);
        });
        list.appendChild(li);
      });
      index = -1;
      list.hidden = false;
      input.setAttribute('aria-expanded', 'true');
    }

    input.addEventListener('input', open);
    input.addEventListener('focus', open);
    input.addEventListener('blur', () => setTimeout(close, 150));
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') return close();
      if (list.hidden) return;
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        index = Math.min(items.length - 1, index + 1);
        highlight();
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        index = Math.max(0, index - 1);
        highlight();
      } else if (event.key === 'Enter') {
        event.preventDefault();
        pick(index < 0 ? 0 : index);
      }
    });
  }

  typeahead($('country-search'), $('country-search-list'), () => state.names, (name) => {
    zoomToCountry(name);
    selectCountry(name);
  });

  typeahead(birthCountry, $('birth-country-list'), () => state.names, () => {});

  /* ------------------------------------------------------------------ auth */

  authForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const email = authEmail.value.trim();
    if (!email) return;

    authSend.disabled = true;
    const { error } = await client.auth.signInWithOtp({
      email: email,
      options: { emailRedirectTo: window.location.origin }
    });
    authSend.disabled = false;

    if (error) {
      authSentLine.textContent = 'That did not send. Try again.';
    } else {
      authSentLine.textContent = 'A link is on its way to ' + email + '.';
    }
    authForm.hidden = true;
    authSent.hidden = false;
  });

  authAgain.addEventListener('click', () => {
    authSent.hidden = true;
    authForm.hidden = false;
    authEmail.focus();
  });

  $('signout').addEventListener('click', async () => {
    await client.auth.signOut();
    window.location.replace(window.location.origin + window.location.pathname);
  });

  profileForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const raw = birthYear.value.trim();
    const year = Number(raw);
    if (!/^\d{4}$/.test(raw) || year < EARLIEST_BIRTH_YEAR || year > THIS_YEAR) {
      birthYear.focus();
      return;
    }

    const typed = storedName(birthCountry.value);
    const country = state.byName.has(typed) ? typed : null;

    const { error } = await client.from('profiles').upsert({
      id: state.user.id,
      birth_year: year,
      birth_country: country
    });
    if (error) {
      console.error(error);
      return;
    }

    state.profile = { birth_year: year, birth_country: country };
    await enterApp();
  });

  async function enterApp() {
    yearInput.min = state.profile.birth_year;
    yearInput.max = THIS_YEAR;
    await loadVisits();
    show('app');
    sizeMap();
    paint();
    updateLegend();
    updateTally();
  }

  async function handleSession(session) {
    if (!session) {
      state.user = null;
      state.handledUser = null;
      show('auth');
      return;
    }
    if (state.handledUser === session.user.id) return;
    state.handledUser = session.user.id;
    state.user = session.user;

    const { data: profile } = await client
      .from('profiles')
      .select('birth_year,birth_country')
      .eq('id', session.user.id)
      .maybeSingle();

    if (!profile) {
      show('profile');
      birthYear.focus();
      return;
    }

    state.profile = profile;
    await enterApp();
  }

  /* ------------------------------------------------------------------ boot */

  (async function boot() {
    await loadWorld();
    buildMap();
    updateLegend();

    const { data } = await client.auth.getSession();
    await handleSession(data ? data.session : null);

    client.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT') {
        state.handledUser = null;
        show('auth');
        return;
      }
      if (event === 'SIGNED_IN' || event === 'INITIAL_SESSION') {
        handleSession(session);
      }
    });
  })();
})();
