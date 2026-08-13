const API = '/api';
const app = document.getElementById('app');
const RADAR_COLORS = ['#E8605D', '#E8A33D', '#E8D23D', '#8FD23D', '#35C7B3', '#3DA6E8'];

// ---------- data fetch helper ----------
async function api(path) {
  const res = await fetch(`${API}${path}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.message || 'Request failed');
    err.detail = body.detail;
    throw err;
  }
  return body;
}

function errorPanel(err) {
  const tpl = document.getElementById('tpl-error').content.cloneNode(true);
  tpl.querySelector('.err-detail').textContent = err.detail || err.message || 'Unknown error';
  return tpl;
}
function loadingPanel() {
  return document.getElementById('tpl-loading').content.cloneNode(true);
}
function emptyPanel(text) {
  const tpl = document.getElementById('tpl-empty').content.cloneNode(true);
  tpl.querySelector('.empty-text').textContent = text;
  return tpl;
}

// ---------- health check ----------
async function checkHealth() {
  const dot = document.getElementById('dbDot');
  const text = document.getElementById('dbStatusText');
  try {
    const status = await api('/health').catch(() => null);
    if (status && status.ok) {
      dot.className = 'dot ok';
      text.textContent = 'CognoDB connected';
    } else {
      dot.className = 'dot down';
      text.textContent = 'CognoDB unreachable';
    }
  } catch {
    dot.className = 'dot down';
    text.textContent = 'CognoDB unreachable';
  }
}

// ---------- routing ----------
function setActiveNav(route) {
  document.querySelectorAll('.navlink').forEach((b) => {
    b.classList.toggle('active', b.dataset.route === route);
  });
}

async function router() {
  const hash = location.hash.slice(1) || 'dashboard';
  const [route, param] = hash.split('/');
  setActiveNav(route === 'package' ? 'search' : route);

  if (route === 'dashboard') return renderDashboard();
  if (route === 'search') return renderSearch();
  if (route === 'package') return renderPackageDetail(decodeURIComponent(param));
  return renderDashboard();
}

document.querySelectorAll('.navlink').forEach((btn) => {
  btn.addEventListener('click', () => { location.hash = `#${btn.dataset.route}`; });
});
window.addEventListener('hashchange', router);

// ---------- Dashboard ----------
async function renderDashboard() {
  app.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <h1 class="page-title">Risk Dashboard</h1>
    <p class="page-sub">A live view of where the dependency graph is fragile.</p>
    <div class="grid-2">
      <div>
        <div class="panel"><h2><span class="badge">①</span> Bus-Factor Risk — single-maintainer packages, ranked by blast radius</h2><div id="busFactor"></div></div>
        <div class="panel"><h2><span class="badge">③</span> Deepest Dependency Chains</h2><div id="deepChains"></div></div>
      </div>
      <div>
        <div class="panel"><h2><span class="badge">④</span> Shared-Maintainer Risk Clusters</h2><div id="sharedRisk"></div></div>
        <div class="panel"><h2><span class="badge">◎</span> Most-Watched Maintainers</h2><div id="maintainers"></div></div>
      </div>
    </div>
  `;
  app.appendChild(wrap);

  loadInto('#busFactor', () => api('/risk/bus-factor'), renderBusFactor);
  loadInto('#deepChains', () => api('/risk/deepest-chains'), renderDeepChains);
  loadInto('#sharedRisk', () => api('/risk/shared-clusters'), renderSharedRisk);
  loadInto('#maintainers', () => api('/maintainers'), renderMaintainers);
}

async function loadInto(selector, fetcher, renderer) {
  const el = app.querySelector(selector);
  el.innerHTML = '';
  el.appendChild(loadingPanel());
  try {
    const data = await fetcher();
    el.innerHTML = '';
    if (!data || data.length === 0) { el.appendChild(emptyPanel('No data yet — run the seed script.')); return; }
    renderer(el, data);
  } catch (err) {
    el.innerHTML = '';
    el.appendChild(errorPanel(err));
  }
}

function renderBusFactor(el, rows) {
  rows.forEach((r, i) => {
    const div = document.createElement('div');
    div.className = 'rank-row';
    div.innerHTML = `
      <span class="rank-num">${i + 1}</span>
      <span class="rank-name">${r.name}</span>
      <span class="rank-val">${r.transitiveDependents} downstream</span>
    `;
    div.querySelector('.rank-name').onclick = () => { location.hash = `#package/${encodeURIComponent(r.name)}`; };
    el.appendChild(div);
  });
}

function renderDeepChains(el, rows) {
  rows.forEach((r) => {
    const div = document.createElement('div');
    div.className = 'rank-row';
    div.innerHTML = `
      <span class="rank-num">${r.depth}h</span>
      <span class="rank-name" style="cursor:default;font-size:13px;color:var(--text-muted)">${r.chain.join(' → ')}</span>
      <span></span>
    `;
    el.appendChild(div);
  });
}

function renderSharedRisk(el, rows) {
  rows.forEach((r) => {
    const div = document.createElement('div');
    div.className = 'rank-row';
    div.innerHTML = `
      <span class="rank-num" style="color:var(--red)">${r.severity}</span>
      <span class="rank-name">${r.relatedPackage}</span>
      <span class="rank-val" style="color:var(--text-muted)">via ${r.sharedMaintainer}</span>
    `;
    div.querySelector('.rank-name').onclick = () => { location.hash = `#package/${encodeURIComponent(r.relatedPackage)}`; };
    el.appendChild(div);
  });
}

function renderMaintainers(el, rows) {
  rows.forEach((r, i) => {
    const div = document.createElement('div');
    div.className = 'rank-row';
    div.innerHTML = `<span class="rank-num">${i + 1}</span><span class="rank-name" style="cursor:default">${r.username}</span><span class="rank-val">${r.packageCount} pkgs</span>`;
    el.appendChild(div);
  });
}

// ---------- Search ----------
async function renderSearch() {
  app.innerHTML = `
    <h1 class="page-title">Explore Packages</h1>
    <p class="page-sub">Search the graph, then open a package to see its blast radius.</p>
    <div class="searchbar">
      <input type="text" id="searchInput" placeholder="Search packages (e.g. fast-router, micro-cache)…" />
    </div>
    <div id="results" class="pkg-list"></div>
  `;
  const input = document.getElementById('searchInput');
  const results = document.getElementById('results');

  async function runSearch(q) {
    results.innerHTML = '';
    results.appendChild(loadingPanel());
    try {
      const rows = await api(`/packages?q=${encodeURIComponent(q)}`);
      results.innerHTML = '';
      if (rows.length === 0) { results.appendChild(emptyPanel('No packages match that search.')); return; }
      rows.forEach((p) => {
        const row = document.createElement('div');
        row.className = 'pkg-row';
        const risk = p.maintainerCount <= 1 ? 'risk-high' : 'risk-ok';
        const riskLabel = p.maintainerCount <= 1 ? 'bus factor: 1' : `${p.maintainerCount} maintainers`;
        row.innerHTML = `
          <span><span class="pkg-name">${p.name}</span><br/><span class="pkg-eco">${p.ecosystem}</span></span>
          <span class="pkg-meta">${p.latestVersion}</span>
          <span class="pkg-meta">${Number(p.weeklyDownloads).toLocaleString()} dl/wk</span>
          <span class="pkg-risk ${risk}">${riskLabel}</span>
        `;
        row.onclick = () => { location.hash = `#package/${encodeURIComponent(p.name)}`; };
        results.appendChild(row);
      });
    } catch (err) {
      results.innerHTML = '';
      results.appendChild(errorPanel(err));
    }
  }

  let debounce;
  input.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => runSearch(input.value), 250);
  });
  runSearch('');
}

// ---------- Package detail ----------
async function renderPackageDetail(name) {
  app.innerHTML = '';
  app.appendChild(loadingPanel());
  let pkg;
  try {
    pkg = await api(`/packages/${encodeURIComponent(name)}`);
  } catch (err) {
    app.innerHTML = '';
    app.appendChild(errorPanel(err));
    return;
  }

  app.innerHTML = `
    <div class="pkg-header">
      <div>
        <h1>${pkg.name}</h1>
        <p>${pkg.description || ''}</p>
        <div class="stat-strip">
          <div class="stat"><span class="num">${pkg.maintainers.filter(m=>m.username).length}</span><span class="label">maintainers</span></div>
          <div class="stat"><span class="num">${pkg.directDependencies.filter(Boolean).length}</span><span class="label">direct deps</span></div>
          <div class="stat"><span class="num">${pkg.directDependents.filter(Boolean).length}</span><span class="label">direct dependents</span></div>
        </div>
      </div>
    </div>

    <div class="grid-2">
      <div class="panel">
        <h2>Blast Radius — who breaks if this package breaks</h2>
        <div class="radar-wrap" id="radarWrap"></div>
        <div class="radar-legend" id="radarLegend"></div>
      </div>
      <div>
        <div class="panel">
          <h2>Maintainers</h2>
          <div class="tag-list">${pkg.maintainers.filter(m=>m.username).map(m => `<span class="tag">${m.username}</span>`).join('') || '<span class="pkg-eco">none on record</span>'}</div>
        </div>
        <div class="panel">
          <h2>Direct Dependencies</h2>
          <div class="tag-list" id="depsList"></div>
        </div>
        <div class="panel">
          <h2>Direct Dependents</h2>
          <div class="tag-list" id="dependentsList"></div>
        </div>
      </div>
    </div>
  `;

  const deps = pkg.directDependencies.filter(Boolean);
  const dependents = pkg.directDependents.filter(Boolean);
  document.getElementById('depsList').innerHTML = deps.length
    ? deps.map(d => `<span class="tag" data-name="${d}">${d}</span>`).join('')
    : '<span class="pkg-eco">none — this is a leaf package</span>';
  document.getElementById('dependentsList').innerHTML = dependents.length
    ? dependents.map(d => `<span class="tag" data-name="${d}">${d}</span>`).join('')
    : '<span class="pkg-eco">nothing depends on this directly</span>';
  document.querySelectorAll('.tag[data-name]').forEach((t) => {
    t.onclick = () => { location.hash = `#package/${encodeURIComponent(t.dataset.name)}`; };
  });

  // Blast radius radar
  const radarWrap = document.getElementById('radarWrap');
  radarWrap.appendChild(loadingPanel());
  try {
    const radius = await api(`/packages/${encodeURIComponent(name)}/blast-radius?hops=4`);
    radarWrap.innerHTML = '';
    if (radius.length === 0) {
      radarWrap.appendChild(emptyPanel('Nothing transitively depends on this package. Zero blast radius.'));
      document.getElementById('radarLegend').innerHTML = '';
      return;
    }
    drawRadar(radarWrap, name, radius);
    const maxHop = Math.max(...radius.map(r => r.hops));
    const legend = document.getElementById('radarLegend');
    legend.innerHTML = Array.from({ length: maxHop }, (_, i) => i + 1)
      .map(h => `<span><span class="legend-dot" style="background:${RADAR_COLORS[(h - 1) % RADAR_COLORS.length]}"></span>${h} hop${h > 1 ? 's' : ''}</span>`)
      .join('');
  } catch (err) {
    radarWrap.innerHTML = '';
    radarWrap.appendChild(errorPanel(err));
  }
}

// Signature visualization: concentric "radar" rings. The target package sits
// at the center; every package that transitively depends on it is placed on
// the ring matching its shortest-path hop distance, color-coded near (red,
// urgent) to far (blue, minor). This makes the query result — "what breaks,
// and how far away is it" — immediately legible without a generic force graph.
function drawRadar(container, centerName, rows) {
  const size = 460;
  const cx = size / 2, cy = size / 2;
  const maxHop = Math.max(...rows.map(r => r.hops));
  const ringGap = (size / 2 - 50) / maxHop;

  const byHop = {};
  rows.forEach(r => { (byHop[r.hops] = byHop[r.hops] || []).push(r.name); });

  let svg = `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">`;
  for (let h = 1; h <= maxHop; h++) {
    svg += `<circle cx="${cx}" cy="${cy}" r="${ringGap * h}" fill="none" stroke="#2A3238" stroke-width="1" />`;
  }
  svg += `<circle cx="${cx}" cy="${cy}" r="22" fill="#E8A33D" />`;
  svg += `<text x="${cx}" y="${cy + 40}" text-anchor="middle" fill="#E8ECEE" font-family="JetBrains Mono" font-size="11" font-weight="700">${centerName}</text>`;

  Object.entries(byHop).forEach(([hop, names]) => {
    const r = ringGap * Number(hop);
    const color = RADAR_COLORS[(Number(hop) - 1) % RADAR_COLORS.length];
    const n = names.length;
    names.forEach((name, i) => {
      const angle = (i / n) * Math.PI * 2 - Math.PI / 2;
      const x = cx + r * Math.cos(angle);
      const y = cy + r * Math.sin(angle);
      svg += `<circle cx="${x}" cy="${y}" r="6" fill="${color}"><title>${name}</title></circle>`;
    });
  });
  svg += `</svg>`;
  container.innerHTML = svg;
}

// ---------- init ----------
checkHealth();
setInterval(checkHealth, 20000);
router();
