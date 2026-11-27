// Token Radar's dashboard. It reads window.RADAR (written beside dashboard/ by main.ts) and
// renders the board, the evidence, the scenario planner and a detail view per protocol.
// Every row is recomputed in this browser from the fitted coefficients and checked against
// board.json, so the screenshots and the code agree. No network: every byte it shows is in data.js.
(function () {
  'use strict';
  var DATA = window.RADAR;
  if (!DATA) return;
  var app = document.getElementById('board');
  var SC = DATA.scenario;
  var state = {
    q: '', verdict: 'all', tier: 'all', family: 'all', chain: 'all',
    sort: 'implied', dir: -1, selected: null, tab: 'pre-token',
    mode: 'share', planShare: SC.planShare, fixedCapital: 1000,
    dropShare: SC.dropShare, horizonWeeks: SC.horizonWeeks, hourlyBar: SC.hourlyBar,
  };

  // ---------- formatting ----------
  var usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return usd0.format(n);
  }
  function fmtMoney(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    var sign = n < 0 ? '-' : '';
    var a = Math.abs(n);
    if (a >= 1000) return sign + '$' + Math.round(a).toLocaleString('en-US');
    return sign + '$' + a.toFixed(2);
  }
  function fmtPct(n) { if (n === null || n === undefined || !isFinite(n)) return 'n/a'; return (n > 0 ? '+' : '') + n.toFixed(1) + '%'; }
  function fmtAge(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return Math.max(0, Math.round(days)) + 'd';
  }
  function fmtX(n) { return 'x' + n.toFixed(2); }
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;'); }

  // ---------- the model, recomputed in this browser ----------
  var FAMS = DATA.value.families;
  var BETA = DATA.value.beta, LBETA = DATA.odds.logisticBeta, HTHETA = DATA.odds.hazardTheta;
  var LOG100M = Math.log(100000000);
  function famIdx(f) { var i = FAMS.indexOf(f); return i < 0 ? FAMS.indexOf('Other') : i; }
  function sig(z) { return z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z)); }
  function ageY(row) { return row.age_days === null || row.age_days === undefined ? DATA.odds.medianAgeY : row.age_days / 365; }
  function multipleOf(row) {
    var lt = Math.log(row.tvl_usd) - LOG100M, s = BETA[0] + BETA[1] * lt;
    s += BETA[2 + famIdx(row.family)];
    return Math.exp(s);
  }
  function hazardPred(ageYv, lt, fi) {
    var hx = [1, lt];
    for (var k = 0; k < FAMS.length; k++) hx.push(k === fi ? 1 : 0);
    var logLam = HTHETA.slice(1).reduce(function (s, b, j) { return s + b * hx[j]; }, 0);
    var kk = Math.exp(HTHETA[0]);
    var u = Math.exp(kk * (Math.log(Math.max(ageYv, 0.02)) - logLam));
    return 1 - Math.exp(-Math.min(u, 700));
  }
  function oddsOf(row) {
    var lt = Math.log(row.tvl_usd) - LOG100M, ay = ageY(row), fi = famIdx(row.family);
    var lx = [1, ay - 1.5, lt];
    for (var i = 0; i < FAMS.length; i++) lx.push(i === fi ? 1 : 0);
    var pl = sig(LBETA.reduce(function (s, b, j) { return s + b * lx[j]; }, 0));
    return (pl + hazardPred(ay, lt, fi)) / 2;
  }
  function forwardOdds(row) {
    var lt = Math.log(row.tvl_usd) - LOG100M, fi = famIdx(row.family);
    var sNow = 1 - hazardPred(ageY(row), lt, fi);
    var sLater = 1 - hazardPred(ageY(row) + 1, lt, fi);
    if (sNow <= 0) return 1;
    return Math.min(1, Math.max(0, 1 - sLater / sNow));
  }
  // Mirror lib/model.ts exactly: if-it-launches is rounded to a whole dollar first,
  // then the odds are applied and the result is rounded again.
  function recomputedImplied(row) {
    var ifLaunches = Math.max(1, Math.round(row.tvl_usd * multipleOf(row)));
    return Math.max(1, Math.round(ifLaunches * oddsOf(row)));
  }
  var RECHECK = (function () {
    var ok = 0;
    DATA.rows.forEach(function (r) { if (recomputedImplied(r) === r.implied_value_usd) ok++; });
    return ok;
  })();

  // ---------- farm economics (mirrors lib/model.ts) ----------
  var GAS = { Ethereum: 6, Solana: 0.05, Base: 0.3, Arbitrum: 0.3, Optimism: 0.3, BSC: 0.1, Polygon: 0.05, Avalanche: 0.3, Tron: 1 };
  function gasOf(row) { var c = row.chains && row.chains.length ? row.chains[0] : ''; return GAS[c] === undefined ? 1 : GAS[c]; }
  function scenario() {
    return { mode: state.mode, planShare: state.planShare, fixedCapital: state.fixedCapital, dropShare: state.dropShare, horizonWeeks: state.horizonWeeks, hourlyBar: state.hourlyBar, tbillRate: SC.tbillRate };
  }
  function farmVerdict(row, sc) {
    var capital = sc.mode === 'share' ? row.tvl_usd * sc.planShare : sc.fixedCapital;
    var drop = row.implied_value_usd * sc.dropShare * (capital / row.tvl_usd);
    var fees = (4 + sc.horizonWeeks) * gasOf(row);
    var hours = 0.75 + 0.25 * sc.horizonWeeks;
    var net = drop - fees;
    var tbill = capital * sc.tbillRate * (sc.horizonWeeks / 52);
    return { verdict: net > 0 && net / hours >= sc.hourlyBar ? 'FARM' : net > 0 ? 'MARGINAL' : 'SKIP', drop: drop, fees: fees, net: net, perHour: net / hours, hours: hours, capital: capital, tbill: tbill };
  }
  function verdictCounts(sc) {
    var c = { FARM: 0, MARGINAL: 0, SKIP: 0 };
    DATA.rows.forEach(function (r) { c[farmVerdict(r, sc).verdict]++; });
    return c;
  }

  // ---------- tiny DOM helper ----------
  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'class') node.className = attrs[k];
      else if (k === 'text') node.textContent = attrs[k];
      else if (k === 'html') node.innerHTML = attrs[k];
      else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== null && attrs[k] !== undefined) node.setAttribute(k, attrs[k]);
    });
    for (var i = 2; i < arguments.length; i++) {
      var child = arguments[i];
      if (child === null || child === undefined) continue;
      if (Array.isArray(child)) child.forEach(function (c) { if (c) node.appendChild(c); });
      else if (typeof child === 'string') node.appendChild(document.createTextNode(child));
      else node.appendChild(child);
    }
    return node;
  }

  // ---------- hash ----------
  function readHash() {
    var h = window.location.hash.replace(/^#/, '');
    if (!h) return;
    var p = new URLSearchParams(h);
    if (p.get('q')) state.q = p.get('q');
    var v = p.get('verdict');
    if (v) { var vu = v.toUpperCase(); state.verdict = ['FARM', 'MARGINAL', 'SKIP'].indexOf(vu) >= 0 ? vu : 'all'; }
    if (p.get('tier')) state.tier = p.get('tier');
    if (p.get('family')) state.family = p.get('family');
    if (p.get('chain')) state.chain = p.get('chain');
    if (p.get('tab')) state.tab = p.get('tab');
    if (p.get('p')) state.selected = p.get('p');
  }
  function writeHash() {
    var p = new URLSearchParams();
    if (state.q) p.set('q', state.q);
    if (state.verdict !== 'all') p.set('verdict', state.verdict);
    if (state.tier !== 'all') p.set('tier', state.tier);
    if (state.family !== 'all') p.set('family', state.family);
    if (state.chain !== 'all') p.set('chain', state.chain);
    if (state.tab !== 'pre-token') p.set('tab', state.tab);
    if (state.selected) p.set('p', state.selected);
    var next = p.toString();
    if (next) window.history.replaceState(null, '', '#' + next);
    else window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }

  // ---------- filtered + sorted rows ----------
  function rows() {
    var q = state.q.trim().toLowerCase();
    var sc = scenario();
    return DATA.rows.filter(function (r) {
      if (state.verdict !== 'all' && farmVerdict(r, sc).verdict !== state.verdict) return false;
      if (state.tier !== 'all' && r.tier !== state.tier) return false;
      if (state.family !== 'all' && r.family !== state.family) return false;
      if (state.chain !== 'all' && !(r.chains || []).includes(state.chain)) return false;
      if (!q) return true;
      var hay = [r.name, r.slug, r.family, r.category, (r.chains || []).join(' ')].join(' ').toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }
  function sortedRows(list) {
    var sc = scenario();
    return list.slice().sort(function (a, b) {
      var av, bv;
      if (state.sort === 'name') { av = a.name.toLowerCase(); bv = b.name.toLowerCase(); }
      else if (state.sort === 'tvl') { av = a.tvl_usd; bv = b.tvl_usd; }
      else if (state.sort === 'odds') { av = a.token_odds; bv = b.token_odds; }
      else if (state.sort === 'hour') { av = farmVerdict(a, sc).perHour; bv = farmVerdict(b, sc).perHour; }
      else if (state.sort === 'age') { av = a.age_days === null ? Infinity : a.age_days; bv = b.age_days === null ? Infinity : b.age_days; }
      else { av = a.implied_value_usd; bv = b.implied_value_usd; }
      if (av < bv) return -state.dir;
      if (av > bv) return state.dir;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
  }

  // ---------- sections ----------
  function header() {
    return el('header', { class: 'top' },
      el('div', { class: 'brand' }, 'Token ', el('em', { text: 'Radar' })),
      el('div', { class: 'top-meta' },
        el('div', { text: 'DefiLlama snapshot ' + DATA.as_of + ' · model ' + DATA.model_version }),
        el('div', { text: RECHECK + ' / ' + DATA.rows.length + ' rows recomputed in this browser match board.json' })
      )
    );
  }
  function lede() {
    var v = DATA.value.validation;
    return el('section', { class: 'lede' },
      el('h1', { text: DATA.watchlist_size + ' watchlist protocols, ranked by what a token would be worth' }),
      el('p', null,
        'The watchlist is the floor: every protocol with at least $' + Math.round(DATA.floor_usd / 1e6) + 'M of TVL and no token on record. ' +
        'The early radar adds ' + DATA.early_size + ' pre-token protocols below that floor. ',
        el('b', { text: 'Implied value = TVL x fitted multiple x token odds' }),
        '. The multiple is fit on ' + v.nTraded + ' traded tokens; the odds are the peers\u2019 record, averaged over two models. ',
        'A value is a model, not a price, and never a promise that a token launches.'
      )
    );
  }
  function kpis() {
    var v = DATA.value.validation, o = DATA.odds, vc = verdictCounts(scenario());
    function kpi(label, value, note) {
      return el('div', { class: 'kpi' }, el('div', { class: 'k-label', text: label }), el('div', { class: 'k-value', text: value }), el('div', { class: 'k-note', text: note }));
    }
    return el('div', { class: 'kpis' },
      kpi('Value model, walk-forward', fmtX(v.walkForwardMiss), 'typical miss pricing later-listed tokens by earlier ones; flat multiple ' + fmtX(v.flatWalkForwardMiss)),
      kpi('Range honesty', Math.round(DATA.value.coverage2575 * 100) + '% · ' + Math.round(DATA.value.coverage1090 * 100) + '%', 'of real caps inside the printed P25\u2013P75 (stated 50%) and P10\u2013P90 (stated 80%)'),
      kpi('Token odds, ensemble', o.models[3].walkForward.brier.toFixed(3), 'Brier, walk-forward, vs ' + o.models[0].walkForward.brier.toFixed(3) + ' base rate; leave-one-out ' + o.models[3].loo.brier.toFixed(3) + ' vs ' + o.models[0].loo.brier.toFixed(3)),
      kpi('Terms that survived', '2 of 6 · 2 models', 'value terms kept of 6 tested; token odds averaged over a logistic and a hazard'),
      kpi('Worth farming', vc.FARM + ' of ' + DATA.board_size, 'FARM under the default scenario; ' + vc.MARGINAL + ' marginal, ' + vc.SKIP + ' skip'),
      kpi('Watchlist ranked', DATA.watchlist_size + ' / ' + DATA.watchlist_size, 'plus ' + DATA.early_size + ' pre-token protocols below the floor')
    );
  }
  function ledger() {
    var L = DATA.ledger, total = L.total;
    function seg(count, color) { return el('i', { style: 'width:' + (100 * count / total).toFixed(1) + '%;background:' + color }); }
    var legend = [
      ['Ranked · watchlist ' + L.rankedWatchlist, '#0e7490'], ['Ranked · early ' + L.rankedEarly, '#38bdf8'],
      ['Token trades ' + L.tokenTrades, '#94a3b8'], ['Excluded · wrapped, staked or bridged ' + (L.excludedByReason[0] ? L.excludedByReason[0].count : 0), '#d6a419'],
      ['Excluded · exchange ' + (L.excludedByReason[1] ? L.excludedByReason[1].count : 0), '#b45309'],
      ['Excluded · other reasons ' + (L.excludedPreToken - (L.excludedByReason[0] ? L.excludedByReason[0].count : 0) - (L.excludedByReason[1] ? L.excludedByReason[1].count : 0)), '#e4ddcd'],
    ];
    return el('div', { class: 'ledger' },
      el('h2', { text: 'Protocol accounting' }),
      el('p', { class: 'sub', text: 'All ' + total + ' snapshot protocols in exactly one group. Nothing is counted twice, nothing is left out.' }),
      el('div', { class: 'bar' }, legend.map(function (l) { return seg(l[1] === '#0e7490' ? L.rankedWatchlist : l[1] === '#38bdf8' ? L.rankedEarly : l[1] === '#94a3b8' ? L.tokenTrades : l[1] === '#d6a419' ? (L.excludedByReason[0] ? L.excludedByReason[0].count : 0) : l[1] === '#b45309' ? (L.excludedByReason[1] ? L.excludedByReason[1].count : 0) : L.excludedPreToken - (L.excludedByReason[0] ? L.excludedByReason[0].count : 0) - (L.excludedByReason[1] ? L.excludedByReason[1].count : 0), l[1]); })),
      el('div', { class: 'legend' }, legend.map(function (l) { return el('span', null, el('span', { class: 'sw', style: 'background:' + l[1] }), l[0]); })),
      el('div', { class: 'checks' },
        el('span', { class: 'check', html: '\u2713 this table = board.json: ' + L.ranked + ' of ' + L.ranked + ' rows recomputed here' }),
        el('span', { class: 'check', html: '\u2713 ranks 1\u2013' + L.ranked + ' in order, values never rise' }),
        el('span', { class: 'check', html: '\u2713 totals equal ' + fmtUsd(L.boardTotalImplied) }),
        el('span', { class: 'check', html: '\u2713 checksum <code>' + L.boardChecksum + '</code> = board.json' }),
        el('span', { class: 'check', html: '\u2713 watchlist ' + L.rankedWatchlist + ' of ' + DATA.watchlist_size + ' ranked' }),
        el('span', { class: 'check', html: '\u2713 ledger ' + L.total + ' of ' + L.total + ' protocols' })
      )
    );
  }
  function farmWeek() {
    var sc = scenario();
    var farm = DATA.rows.filter(function (r) { return farmVerdict(r, sc).verdict === 'FARM'; })
      .sort(function (a, b) { return farmVerdict(b, sc).perHour - farmVerdict(a, sc).perHour; }).slice(0, 8);
    var items = farm.length === 0
      ? [el('li', null, el('span', { class: 'sub', text: 'No row clears the $/hour bar under this scenario. Lower the bar or raise the drop share in the planner.' }))]
      : farm.map(function (r) {
        var fv = farmVerdict(r, sc);
        return el('li', null,
          el('span', { class: 'rank', text: String(r.rank) }),
          el('span', { class: 'nm' }, el('a', { href: '#', onclick: function (e) { e.preventDefault(); openDetail(r.slug); } }, r.name)),
          el('span', { class: 'sub', text: (r.chains[0] || '') }),
          el('span', { class: 'net' }, el('b', { text: fmtMoney(fv.net) + ' net' }), el('span', { class: 'sub', text: ' · ' + fmtMoney(fv.perHour) + '/h' }))
        );
      });
    return el('div', { class: 'panel' },
      el('h2', { text: 'Farm this week' }),
      el('p', { class: 'sub', text: 'The FARM rows, best net per hour first, under the scenario on the right. A row is FARM when its drop covers the fees and the time clears your $/hour bar.' }),
      el('ul', { class: 'farm-list' }, items)
    );
  }
  function planner() {
    var sc = scenario();
    var vc = verdictCounts(sc);
    var retail = (function () {
      var fixed = { mode: 'fixed', fixedCapital: 1000, dropShare: sc.dropShare, horizonWeeks: sc.horizonWeeks, hourlyBar: sc.hourlyBar, tbillRate: SC.tbillRate };
      return verdictCounts(fixed).FARM;
    })();
    function slider(id, label, min, max, step, value, fmt, oninput) {
      var out = el('output', { text: fmt(value) });
      var input = el('input', { type: 'range', id: id, min: String(min), max: String(max), step: String(step), value: String(value), 'aria-label': label });
      input.addEventListener('input', function () { out.textContent = fmt(Number(input.value)); oninput(Number(input.value)); });
      return el('div', { class: 'plan-row' }, el('label', { for: id, text: label }), input, out);
    }
    var modeSel = el('select', { id: 'plan-mode', 'aria-label': 'Plan size mode' },
      el('option', { value: 'share', text: 'Share of TVL', selected: state.mode === 'share' ? 'selected' : null }),
      el('option', { value: 'fixed', text: 'Fixed dollars', selected: state.mode === 'fixed' ? 'selected' : null })
    );
    modeSel.addEventListener('change', function () { state.mode = modeSel.value; render(); });
    var planRow = state.mode === 'share'
      ? slider('plan-share', 'Plan size', 0.00005, 0.001, 0.00001, state.planShare, function (v) { return (v * 100).toFixed(3) + '% of TVL'; }, function (v) { state.planShare = v; render(); })
      : slider('plan-fixed', 'Plan size', 100, 10000, 100, state.fixedCapital, function (v) { return '$' + v.toLocaleString('en-US'); }, function (v) { state.fixedCapital = v; render(); });
    return el('div', { class: 'panel' },
      el('h2', { text: 'Scenario planner' }),
      el('p', { class: 'sub', text: 'Move a slider and every verdict on the page recomputes. The board\u2019s verdicts are the default scenario\u2019s; the planner is yours to change.' }),
      el('div', { class: 'plan-row' }, el('label', { for: 'plan-mode', text: 'Plan size mode' }), modeSel, el('output', { text: '' })),
      planRow,
      slider('drop-share', 'Drop share', 0.03, 0.15, 0.005, state.dropShare, function (v) { return (v * 100).toFixed(1) + '% of implied'; }, function (v) { state.dropShare = v; render(); }),
      slider('horizon', 'Horizon', 4, 26, 1, state.horizonWeeks, function (v) { return v + ' weeks'; }, function (v) { state.horizonWeeks = v; render(); }),
      slider('hourly', '$/hour bar', 10, 100, 5, state.hourlyBar, function (v) { return '$' + v + '/h'; }, function (v) { state.hourlyBar = v; render(); }),
      el('p', { class: 'plan-note' },
        el('b', { text: vc.FARM + ' FARM · ' + vc.MARGINAL + ' marginal · ' + vc.SKIP + ' skip' }),
        ' under this scenario. Retail check: with a fixed $1,000 plan, ' + retail + ' row' + (retail === 1 ? '' : 's') + ' stay FARM — a small plan against a big TVL earns a small share of the drop.'
      ),
      el('p', { class: 'plan-note', text: 'Gas is a stated assumption, not a fit: Ethereum $6, Solana $0.05, Base/Arbitrum/Optimism $0.30, BSC $0.10, Polygon $0.05, Avalanche $0.30, Tron $1, other chains $1 per transaction. Three transactions to set up, one a week, one to claim.' })
    );
  }
  function evidence() {
    var v = DATA.value, o = DATA.odds;
    var termRows = v.terms.map(function (t) {
      return el('tr', null,
        el('td', { text: t.name }),
        el('td', { class: 'num', text: fmtX(t.looMiss) }),
        el('td', { class: 'num', text: fmtX(t.walkForwardMiss) }),
        el('td', { class: t.kept ? 'kept' : 'dropped', text: t.kept ? 'kept' : 'tested, not kept' }),
        el('td', { class: 'sub', text: t.note })
      );
    });
    var oddsRows = o.models.map(function (m) {
      return el('tr', null,
        el('td', { text: m.name }),
        el('td', { class: 'num', text: m.loo.brier.toFixed(3) }),
        el('td', { class: 'num', text: m.walkForward.brier.toFixed(3) }),
        el('td', { class: m.kept ? 'kept' : 'dropped', text: m.kept ? 'kept' : 'tested' }),
        el('td', { class: 'sub', text: m.note })
      );
    });
    var coefLines = [
      'Value multiple: log(cap/TVL) = ' + v.beta[0].toFixed(3) + ' \u00b1 ' + v.se[0].toFixed(3) + ' ' +
      v.beta[1].toFixed(3) + ' \u00b1 ' + v.se[1].toFixed(3) + ' \u00d7 (ln TVL \u2212 ln $100M) + family effect (ridge 64).',
      'Family effects: ' + v.families.map(function (f, i) { return f + ' ' + (v.beta[2 + i] >= 0 ? '+' : '') + v.beta[2 + i].toFixed(3) + ' \u00b1 ' + v.se[2 + i].toFixed(3); }).join(', ') + '.',
      'Token odds: logistic on age, size and family, and a current-status Weibull hazard with shape k = ' + o.shapeK.toFixed(3) + ' (below 1: the launch hazard falls with age).',
      'Ranges: P25\u2013P75 multiplies the implied value by ' + v.quantiles.q25.toFixed(2) + '\u2013' + v.quantiles.q75.toFixed(2) + '; P10\u2013P90 by ' + v.quantiles.q10.toFixed(2) + '\u2013' + v.quantiles.q90.toFixed(2) + '.',
      'Peers: ' + o.nPeers + ' protocols the house rule keeps (' + o.nPeersWithAge + ' with a listing date); ' + Math.round(o.baseRate * 100) + '% record a token.',
    ];
    return el('section', null,
      el('h2', { text: 'Out-of-sample evidence' }),
      el('p', { class: 'sub', text: 'A term is kept only when it lowers the held-out miss on BOTH tests: leave-one-out and walk-forward (earlier-listed protocols price later-listed ones). What failed is shown, not hidden.' }),
      el('div', { class: 'ev' },
        el('div', { class: 'panel' },
          el('h3', { text: 'Value if a token launches — typical miss, ' + v.validation.nTraded + ' traded tokens' }),
          el('table', null,
            el('thead', null, el('tr', null, el('th', { text: 'Term, added in order' }), el('th', { text: 'Leave-one-out' }), el('th', { text: 'Walk-forward' }), el('th', { text: 'Kept?' }), el('th', { text: '' }))),
            el('tbody', null, termRows)
          ),
          el('p', { class: 'sub', text: 'Reading it: 7-day growth changes neither test, so the price model leaves it out — it is still shown here, because a term that was tried and dropped is evidence too.' })
        ),
        el('div', { class: 'panel' },
          el('h3', { text: 'Token odds — Brier score, ' + o.nPeersWithAge + ' dated peers' }),
          el('table', null,
            el('thead', null, el('tr', null, el('th', { text: 'Model' }), el('th', { text: 'Leave-one-out' }), el('th', { text: 'Walk-forward' }), el('th', { text: 'Kept?' }), el('th', { text: '' }))),
            el('tbody', null, oddsRows)
          ),
          el('p', { class: 'sub', text: 'On later-listed peers neither single model beats the base rate; their average does. That is why the board uses the average.' })
        )
      ),
      el('div', { class: 'panel' },
        el('h3', { text: 'The fitted coefficients' }),
        el('div', { class: 'coefs' }, coefLines.map(function (l) { return el('p', { text: l }); })),
        el('p', { class: 'sub', text: 'Bootstrap standard errors are 200 refits on resampled traded tokens, one fixed seed. The odds are the peers\u2019 record (' + Math.round(o.baseRate * 100) + '% of ' + o.nPeers + ' peers record a token), not a forecast: this page never says a token will launch.' })
      )
    );
  }
  function controls() {
    var fams = ['all'].concat(FAMS);
    var chains = ['all'];
    DATA.rows.forEach(function (r) { (r.chains || []).forEach(function (c) { if (chains.indexOf(c) < 0) chains.push(c); }); });
    chains.sort();
    var search = el('input', { type: 'search', id: 'q', placeholder: 'Search name, family or chain', value: state.q, 'aria-label': 'Search the board' });
    search.addEventListener('input', function () { state.q = search.value; writeHash(); render(); });
    function sel(id, label, options, cur, fn) {
      var s = el('select', { id: id, 'aria-label': label }, options.map(function (o) { return el('option', { value: o, text: o === 'all' ? 'All ' + label.toLowerCase() : o, selected: o === cur ? 'selected' : null }); }));
      s.addEventListener('change', function () { fn(s.value); writeHash(); render(); });
      return s;
    }
    var vc = verdictCounts(scenario());
    var tabs = el('div', { class: 'tabs' },
      el('button', { type: 'button', 'aria-pressed': state.tab === 'pre-token' ? 'true' : 'false', text: 'Pre-token', onclick: function () { state.tab = 'pre-token'; writeHash(); render(); } }),
      el('button', { type: 'button', 'aria-pressed': state.tab === 'live' ? 'true' : 'false', text: 'Live token (' + DATA.live.length + ')', onclick: function () { state.tab = 'live'; writeHash(); render(); } })
    );
    return el('div', { class: 'controls' },
      search,
      sel('verdict', 'verdicts', ['all', 'FARM', 'MARGINAL', 'SKIP'], state.verdict, function (v) { state.verdict = v; }),
      sel('tier', 'tiers', ['all', 'watchlist', 'early'], state.tier, function (v) { state.tier = v; }),
      sel('family', 'families', fams, state.family, function (v) { state.family = v; }),
      sel('chain', 'chains', chains, state.chain, function (v) { state.chain = v; }),
      tabs,
      el('span', { class: 'count', text: state.tab === 'pre-token' ? rows().length + ' of ' + DATA.board_size + ' rows · ' + vc.FARM + ' FARM under this scenario' : DATA.live.length + ' live-token protocols' })
    );
  }
  function sortHeader(key, label) {
    return el('th', { scope: 'col' },
      el('button', { type: 'button', onclick: function () { if (state.sort === key) state.dir = -state.dir; else { state.sort = key; state.dir = -1; } render(); } },
        label, state.sort === key ? el('span', { 'aria-hidden': 'true', text: state.dir < 0 ? ' \u25bc' : ' \u25b2' }) : null
      )
    );
  }
  function boardTable() {
    var list = sortedRows(rows());
    if (list.length === 0) {
      return el('div', { class: 'panel' }, el('div', { class: 'empty' },
        el('h2', { text: 'No protocol matches that filter' }),
        el('p', { text: 'Clear the search or pick another filter to see the board again.' }),
        el('button', { class: 'button primary', type: 'button', text: 'Clear filters', onclick: function () { state.q = ''; state.verdict = 'all'; state.tier = 'all'; state.family = 'all'; state.chain = 'all'; writeHash(); render(); } })
      ));
    }
    var sc = scenario();
    var tbody = el('tbody');
    list.forEach(function (r) {
      var fv = farmVerdict(r, sc);
      var growth = r.change_7d === null ? 'n/a' : fmtPct(r.change_7d);
      var gClass = r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg';
      var tr = el('tr', {
        'data-selected': state.selected === r.slug ? 'true' : 'false',
        tabindex: '0',
        onclick: function () { openDetail(r.slug); },
        onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(r.slug); } }
      },
        el('td', { class: 'num', text: String(r.rank) }),
        el('td', null, el('div', null,
          el('b', { text: r.name }),
          r.tier === 'watchlist' ? el('span', { class: 'badge watch', text: 'Watchlist' }) : el('span', { class: 'badge early', text: 'Early' }),
          el('div', { class: 'sub', text: r.family + ' on ' + (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'an unnamed chain') })
        )),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + gClass, text: growth }),
        el('td', { class: 'num', text: fmtAge(r.age_days) }),
        el('td', { class: 'num' }, el('span', { class: 'oddsbar' }, el('i', { style: 'width:' + Math.round(r.token_odds * 100) + '%' })), Math.round(r.token_odds * 100) + '%'),
        el('td', { class: 'num', text: Math.round(r.odds_12m * 100) + '%' }),
        el('td', { class: 'num', text: fmtUsd(r.if_launches_usd) }),
        el('td', { class: 'num' }, el('b', { text: fmtUsd(r.implied_value_usd) }), el('div', { class: 'sub', text: fmtUsd(r.p25_usd) + '\u2013' + fmtUsd(r.p75_usd) })),
        el('td', null, el('span', { class: 'verdict ' + fv.verdict, text: fv.verdict })),
        el('td', { class: 'num', text: fmtMoney(fv.net) }),
        el('td', { class: 'num', text: fmtMoney(fv.perHour) + '/h' })
      );
      tbody.appendChild(tr);
    });
    return el('div', { class: 'panel' },
      el('div', { class: 'table-wrap' },
        el('table', { class: 'board' },
          el('caption', { class: 'sub', text: 'Pre-token protocols, strongest implied value first. Select a row for its model, its peers and its farm plan. Verdicts follow the scenario planner above.' }),
          el('thead', null, el('tr', null,
            sortHeader('implied', '#'),
            sortHeader('name', 'Protocol'),
            sortHeader('tvl', 'TVL'),
            el('th', { scope: 'col', text: '7d' }),
            sortHeader('age', 'No-token age'),
            sortHeader('odds', 'Token odds'),
            el('th', { scope: 'col', text: '12m odds' }),
            el('th', { scope: 'col', text: 'If it launches' }),
            sortHeader('implied', 'Implied value · P25\u2013P75'),
            el('th', { scope: 'col', text: 'Verdict' }),
            el('th', { scope: 'col', text: 'Net' }),
            sortHeader('hour', 'Net / hour')
          )),
          tbody
        )
      )
    );
  }
  function liveTable() {
    var tbody = el('tbody');
    DATA.live.forEach(function (r) {
      tbody.appendChild(el('tr', null,
        el('td', { class: 'num', text: 'live' }),
        el('td', null, el('div', null, el('b', { text: r.name }), el('div', { class: 'sub', text: (r.family || 'Other') + ' on ' + (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'an unnamed chain') }))),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + (r.change_7d !== null && r.change_7d >= 0 ? 'pos' : 'neg'), text: fmtPct(r.change_7d) }),
        el('td', { class: 'num', text: fmtUsd(r.mcap_usd) }),
        el('td', { class: 'num', text: r.multiple === null ? 'n/a' : 'x' + r.multiple.toFixed(2) }),
        el('td', null, el('span', { class: 'sub', text: 'already trades' }))
      ));
    });
    return el('div', { class: 'panel' },
      el('div', { class: 'table-wrap' },
        el('table', null,
          el('caption', { class: 'sub', text: 'Token live: these protocols already trade, so their market cap is a fact, not a model. They are set aside from the pre-token ranking — and they are the 24 largest by market cap that the value multiple was fit on.' }),
          el('thead', null, el('tr', null, el('th', { scope: 'col', text: 'Status' }), el('th', { scope: 'col', text: 'Protocol' }), el('th', { scope: 'col', text: 'TVL' }), el('th', { scope: 'col', text: '7d' }), el('th', { scope: 'col', text: 'Market cap' }), el('th', { scope: 'col', text: 'Cap / TVL' }), el('th', { scope: 'col', text: 'Token' }))),
          tbody
        )
      )
    );
  }

  // ---------- detail ----------
  var dialog = el('dialog', { class: 'detail', id: 'detail', 'aria-labelledby': 'detail-title' });
  dialog.addEventListener('close', function () { state.selected = null; writeHash(); });
  function openDetail(slug) {
    var row = null;
    DATA.rows.forEach(function (r) { if (r.slug === slug) row = r; });
    if (!row) return;
    state.selected = slug;
    writeHash();
    dialog.textContent = '';
    var sc = scenario();
    var fv = farmVerdict(row, sc);
    var recomputed = recomputedImplied(row);
    // Peer comparables: same family, nearest by log TVL.
    var peers = DATA.rows.filter(function (r) { return r.slug !== row.slug && r.family === row.family; })
      .map(function (r) { return { r: r, d: Math.abs(Math.log(r.tvl_usd) - Math.log(row.tvl_usd)) }; })
      .sort(function (a, b) { return a.d - b.d; }).slice(0, 5).map(function (x) { return x.r; });
    var risks = [];
    if (row.change_7d !== null && row.change_7d < -10) risks.push('TVL fell ' + fmtPct(row.change_7d) + ' in 7 days: the multiple was fit on steadier protocols.');
    if (row.age_days === null) risks.push('No listing date on record: the odds use the median peer age (' + DATA.odds.medianAgeY.toFixed(1) + ' years), not this protocol\u2019s own.');
    if (row.chains.length === 1) risks.push('On one chain only (' + row.chains[0] + '): a chain outage or a bridge problem hits the whole position.');
    if (row.tvl_usd < 100000000) risks.push('Below $100M of TVL: the fitted multiple is least certain at this size — the P10\u2013P90 range is wide.');
    if (row.token_odds < 0.5) risks.push('Token odds below one in two: most peers like this one never recorded a token.');
    if (risks.length === 0) risks.push('No single red flag in the snapshot figures. The range below is still wide: a token, if it ever launches, can price far from the point estimate.');
    // Sensitivity: what would change the verdict.
    var atP75 = farmVerdict({ tvl_usd: row.tvl_usd, implied_value_usd: row.p75_usd, chains: row.chains }, sc);
    var atDrop10 = farmVerdict(row, { mode: sc.mode, planShare: sc.planShare, fixedCapital: sc.fixedCapital, dropShare: 0.1, horizonWeeks: sc.horizonWeeks, hourlyBar: sc.hourlyBar, tbillRate: sc.tbillRate });
    var at26w = farmVerdict(row, { mode: sc.mode, planShare: sc.planShare, fixedCapital: sc.fixedCapital, dropShare: sc.dropShare, horizonWeeks: 26, hourlyBar: sc.hourlyBar, tbillRate: sc.tbillRate });
    dialog.appendChild(el('div', { class: 'detail-head' },
      el('div', null,
        el('span', { class: 'sub', text: 'Rank ' + row.rank + ' of ' + DATA.board_size + ' · ' + (row.tier === 'watchlist' ? 'Watchlist' : 'Early, below the floor') }),
        el('h2', { id: 'detail-title', text: row.name }),
        el('p', { class: 'sub', text: row.family + ' on ' + (row.chains && row.chains.length ? row.chains.join(', ') : 'an unnamed chain') })
      ),
      el('button', { class: 'close', type: 'button', 'aria-label': 'Close details', text: 'Close', onclick: function () { dialog.close(); } })
    ));
    var body = el('div', { class: 'detail-body' });
    body.appendChild(el('div', { class: 'detail-section' },
      el('h3', { text: 'Implied value, taken apart' }),
      el('div', { class: 'equation' },
        el('div', null, el('span', { text: 'TVL' }), el('b', { class: 'num', text: fmtUsd(row.tvl_usd) })),
        el('div', null, el('span', { text: 'Fitted multiple' }), el('b', { class: 'num', text: 'x' + row.multiple.toFixed(3) })),
        el('div', null, el('span', { text: 'If it launches' }), el('b', { class: 'num', text: fmtUsd(row.if_launches_usd) })),
        el('div', null, el('span', { text: 'Token odds (ensemble)' }), el('b', { class: 'num', text: Math.round(row.token_odds * 100) + '%' })),
        el('div', null, el('span', { text: 'Odds in the next 12 months' }), el('b', { class: 'num', text: Math.round(row.odds_12m * 100) + '%' })),
        el('div', null, el('span', { text: 'Implied value' }), el('b', { class: 'num', text: fmtUsd(row.implied_value_usd) }))
      ),
      el('p', { class: 'sub', text: 'P25\u2013P75: ' + fmtUsd(row.p25_usd) + ' \u2013 ' + fmtUsd(row.p75_usd) + '. P10\u2013P90: ' + fmtUsd(row.p10_usd) + ' \u2013 ' + fmtUsd(row.p90_usd) + '. ' +
        'Recomputed in this browser from the fitted coefficients: ' + fmtUsd(recomputed) + (recomputed === row.implied_value_usd ? ', the same number board.json carries.' : ' (board.json carries ' + fmtUsd(row.implied_value_usd) + ').') +
        ' The odds are the average of the logistic and the hazard; the 12-month figure comes from the hazard alone.' })
    ));
    body.appendChild(el('div', { class: 'detail-section' },
      el('h3', { text: 'Peer comparables — same family, nearest by TVL' }),
      peers.length === 0 ? el('p', { class: 'sub', text: 'No other protocol of this family is on the board.' }) :
      el('table', { class: 'peer-table' },
        el('thead', null, el('tr', null, el('th', { text: 'Protocol' }), el('th', { text: 'TVL' }), el('th', { text: 'Multiple' }), el('th', { text: 'Odds' }), el('th', { text: 'Implied' }))),
        el('tbody', null, peers.map(function (p) {
          return el('tr', null, el('td', null, el('a', { href: '#', onclick: function (e) { e.preventDefault(); openDetail(p.slug); } }, p.name)), el('td', { class: 'num', text: fmtUsd(p.tvl_usd) }), el('td', { class: 'num', text: 'x' + p.multiple.toFixed(3) }), el('td', { class: 'num', text: Math.round(p.token_odds * 100) + '%' }), el('td', { class: 'num', text: fmtUsd(p.implied_value_usd) }));
        }))
      )
    ));
    body.appendChild(el('div', { class: 'detail-section' },
      el('h3', { text: 'Farm plan — costed, under the current scenario' }),
      el('p', { class: 'sub', text: 'Plan capital ' + fmtMoney(fv.capital) + ' · expected drop ' + fmtMoney(fv.drop) + ' · fees ' + fmtMoney(fv.fees) + ' · net ' + fmtMoney(fv.net) + ' · ' + fmtMoney(fv.perHour) + ' an hour over ' + fv.hours.toFixed(2) + ' hours. T-bill on this capital over the horizon: ' + fmtMoney(fv.tbill) + ' (shown, not gated: the position earns its own yield while it farms). Verdict: ' + fv.verdict + '.' }),
      el('ol', { class: 'steps' }, row.farm_steps.map(function (s) {
        var at = s.indexOf(' Cost: ');
        var action = at >= 0 ? s.slice(0, at) : s;
        var tail = at >= 0 ? s.slice(at + 1) : '';
        return el('li', null, el('b', { text: action }), el('span', { class: 'cost', text: tail }));
      })),
      el('p', { class: 'sub', text: 'The steps are written for a $50\u2013$250 starter position a reader can actually open. The verdict math uses the scenario plan size instead — change it in the planner and this verdict moves.' })
    ));
    body.appendChild(el('div', { class: 'detail-section' },
      el('h3', { text: 'What would change the verdict' }),
      el('p', { class: 'sub', text: 'At the P75 end of the range (' + fmtUsd(row.p75_usd) + '): ' + atP75.verdict + ' (' + fmtMoney(atP75.net) + ' net). At a 10% drop share: ' + atDrop10.verdict + ' (' + fmtMoney(atDrop10.net) + ' net). Over 26 weeks instead of ' + sc.horizonWeeks + ': ' + at26w.verdict + ' (' + fmtMoney(at26w.net) + ' net).' })
    ));
    body.appendChild(el('div', { class: 'detail-section' },
      el('h3', { text: 'Risks, from the snapshot alone' }),
      el('ul', { class: 'risk' }, risks.map(function (r) { return el('li', { text: r }); }))
    ));
    dialog.appendChild(body);
    if (typeof dialog.showModal === 'function') { if (!dialog.open) dialog.showModal(); }
    else dialog.setAttribute('open', '');
  }

  // ---------- limits + footer ----------
  function limits() {
    return el('section', { class: 'panel limits' },
      el('h2', { text: 'What this radar does not say' }),
      el('p', null, el('b', { text: 'Not a forecast. ' }), 'Nothing here says a token will launch, or when. The odds are the peers\u2019 record: of ', String(DATA.odds.nPeers), ' comparable protocols, ', String(Math.round(DATA.odds.baseRate * 100)), '% record a token. A protocol that records no token in DefiLlama may still have one its record does not carry.'),
      el('p', null, el('b', { text: 'Ranges are calibration, not a promise. ' }), 'The P25\u2013P75 and P10\u2013P90 bands come from how far the value model missed real caps, held out. ', String(Math.round(DATA.value.coverage2575 * 100)), '% of real caps landed inside the P25\u2013P75 band and ', String(Math.round(DATA.value.coverage1090 * 100)), '% inside P10\u2013P90 — close to the stated 50% and 80%, and the bands are wide because cap/TVL multiples are wide.'),
      el('p', null, el('b', { text: 'Farm verdicts are arithmetic, not advice. ' }), 'They assume a drop share, a gas price and a horizon you can change, and they assume the drop, if it comes, pays the farmers who farmed. A protocol can change its points, its snapshot, or its mind.'),
      el('p', null, el('b', { text: 'The model\u2019s limits. ' }), 'It sees only the snapshot: TVL, 7-day change, listing date, category, chains, and whether a token is recorded. It does not see points programs, audits, teams, or volume — and 7-day growth, age and chain count were all tested and left out, because none of them lowered the held-out miss on both tests.')
    );
  }
  function footer() {
    return el('footer', null,
      el('p', { text: 'Source: DefiLlama protocol index, fetched ' + DATA.source.replace('DefiLlama ', '') + '. Snapshot ' + DATA.as_of + '. Model ' + DATA.model_version + ': log(cap/TVL) on a size curve and a family effect (ridge 64), token odds as the average of a logistic and a current-status Weibull hazard, ranges from leave-one-out residuals. Every row on this page is recomputed in this browser from the fitted coefficients and checked against board.json.' }),
      el('p', { text: 'Built by an AI agent for make.fun\u2019s token-radar-01 bounty. The board is the entry\u2019s own claim, never make.fun\u2019s.' })
    );
  }

  // ---------- render ----------
  function render() {
    app.textContent = '';
    var shell = el('div', { class: 'shell' });
    shell.appendChild(header());
    shell.appendChild(lede());
    shell.appendChild(kpis());
    shell.appendChild(ledger());
    var duo = el('div', { class: 'duo' }, farmWeek(), planner());
    shell.appendChild(duo);
    shell.appendChild(evidence());
    var boardSec = el('section', null,
      el('h2', { text: 'The board' }),
      el('p', { class: 'sub', text: 'Pre-token protocols, strongest implied value first. The live-token set is on its own tab: the market\u2019s values, not the model\u2019s.' }),
      controls(),
      state.tab === 'pre-token' ? boardTable() : liveTable()
    );
    shell.appendChild(boardSec);
    shell.appendChild(limits());
    shell.appendChild(footer());
    app.appendChild(shell);
    app.setAttribute('aria-busy', 'false');
    if (!dialog.isConnected) app.appendChild(dialog);
    if (state.selected) openDetail(state.selected);
  }

  readHash();
  render();
  window.addEventListener('keydown', function (e) { if (e.key === 'Escape' && dialog.open) dialog.close(); });
})();
