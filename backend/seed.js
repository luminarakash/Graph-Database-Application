// seed.js
// Generates a realistic-looking open-source dependency graph and loads it into
// CognoDB using batched, parameterised Cypher (UNWIND + MERGE). No string
// concatenation anywhere - every value goes through query parameters.
//
// Run with: npm run seed   (from backend/, after .env is configured)

require('dotenv').config();
const neo4j = require('neo4j-driver');

const { COGNODB_URI, COGNODB_USER, COGNODB_PASSWORD } = process.env;
if (!COGNODB_URI || !COGNODB_USER || !COGNODB_PASSWORD) {
  console.error('Missing COGNODB_URI / COGNODB_USER / COGNODB_PASSWORD in backend/.env');
  process.exit(1);
}

const driver = neo4j.driver(COGNODB_URI, neo4j.auth.basic(COGNODB_USER, COGNODB_PASSWORD));

// ---------- deterministic-ish random generation ----------
function seededRandom(seed) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}
const rand = seededRandom(42);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const int = (min, max) => min + Math.floor(rand() * (max - min + 1));

const ADJ = ['fast', 'tiny', 'micro', 'simple', 'smart', 'safe', 'lazy', 'quick', 'deep', 'clean',
  'flex', 'zero', 'auto', 'super', 'core', 'pure', 'nano', 'lite', 'rapid', 'solid'];
const NOUN = ['router', 'parser', 'stream', 'cache', 'auth', 'logger', 'queue', 'schema', 'form',
  'grid', 'fetch', 'store', 'socket', 'crypto', 'render', 'validate', 'events', 'config',
  'template', 'markdown', 'date', 'color', 'test', 'build', 'lint', 'bundle', 'http', 'json',
  'css', 'dom'];
const SUFFIX_NPM = ['', '-js', '-core', '-utils', '-lib', '-cli', '-kit', '-sdk', ''];
const SUFFIX_PY = ['', '-py', '_core', '_utils', '_lib', '_cli', ''];

const FIRST = ['alex', 'sam', 'jordan', 'kai', 'priya', 'wei', 'noor', 'diego', 'yuki', 'mateo',
  'lena', 'omar', 'ines', 'ravi', 'zoe', 'finn', 'mira', 'theo', 'anya', 'jules'];

function makeMaintainerPool(n) {
  const names = new Set();
  while (names.size < n) {
    names.add(`${pick(FIRST)}${int(1, 999)}`);
  }
  return [...names];
}

function makePackageName(ecosystem, used) {
  let name;
  do {
    const suffix = ecosystem === 'npm' ? pick(SUFFIX_NPM) : pick(SUFFIX_PY);
    const sep = ecosystem === 'npm' ? '-' : '_';
    name = `${pick(ADJ)}${sep}${pick(NOUN)}${suffix}`;
  } while (used.has(name));
  used.add(name);
  return name;
}

async function main() {
  const NUM_PACKAGES = 320;
  const MAINTAINER_POOL_SIZE = 140;
  const LAYERS = 6; // dependency depth

  const maintainers = makeMaintainerPool(MAINTAINER_POOL_SIZE);
  const usedNames = new Set();
  const packages = [];

  // Build packages in layers: layer 0 = leaves (no dependencies),
  // higher layers depend only on strictly lower layers -> guarantees a DAG,
  // so dependency chains and blast-radius queries have clean, finite depth.
  const layerSize = Math.ceil(NUM_PACKAGES / LAYERS);
  for (let layer = 0; layer < LAYERS; layer++) {
    for (let i = 0; i < layerSize && packages.length < NUM_PACKAGES; i++) {
      const ecosystem = rand() < 0.6 ? 'npm' : 'pip';
      const name = makePackageName(ecosystem, usedNames);
      packages.push({
        name,
        ecosystem,
        layer,
        description: `A ${pick(ADJ)} ${pick(NOUN)} library for modern ${ecosystem === 'npm' ? 'JavaScript' : 'Python'} projects.`,
        latest_version: `${int(0, 4)}.${int(0, 20)}.${int(0, 9)}`,
        weekly_downloads: layer === 0 ? int(5000, 900000) : int(100, 400000),
      });
    }
  }

  // Dependencies: each package (layer > 0) depends on 1-4 packages from
  // strictly lower layers.
  const byLayer = {};
  packages.forEach((p) => {
    byLayer[p.layer] = byLayer[p.layer] || [];
    byLayer[p.layer].push(p);
  });

  const dependsOn = []; // { from, to }
  packages.forEach((p) => {
    if (p.layer === 0) return;
    const depCount = int(1, 4);
    const candidates = [];
    for (let l = 0; l < p.layer; l++) candidates.push(...(byLayer[l] || []));
    for (let i = 0; i < depCount && candidates.length; i++) {
      const dep = pick(candidates);
      if (dep.name !== p.name) dependsOn.push({ from: p.name, to: dep.name });
    }
  });

  // Maintainers: ~30% of packages get exactly one maintainer (bus-factor risk),
  // the rest get 2-5.
  const maintains = []; // { username, packageName, since }
  packages.forEach((p) => {
    const count = rand() < 0.3 ? 1 : int(2, 5);
    const chosen = new Set();
    while (chosen.size < count) chosen.add(pick(maintainers));
    chosen.forEach((username) => {
      maintains.push({
        username,
        packageName: p.name,
        since: `${int(2016, 2024)}-${String(int(1, 12)).padStart(2, '0')}-01`,
      });
    });
  });

  // A handful of vulnerabilities on popular low-layer packages.
  const vulnCandidates = packages.filter((p) => p.layer <= 2);
  const vulns = [];
  for (let i = 0; i < 12; i++) {
    const target = pick(vulnCandidates);
    vulns.push({
      packageName: target.name,
      cve_id: `CVE-2025-${1000 + i}`,
      severity: pick(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
      published_date: `2025-${String(int(1, 12)).padStart(2, '0')}-15`,
    });
  }

  const session = driver.session();
  try {
    console.log(`Seeding ${packages.length} packages, ${dependsOn.length} dependency edges, ` +
      `${maintains.length} maintainer edges, ${vulns.length} vulnerabilities...`);

    // Packages + a single Version node each (kept simple: one "latest" version per package)
    await session.run(
      `
      UNWIND $packages AS pkg
      MERGE (p:Package {name: pkg.name})
      SET p.ecosystem = pkg.ecosystem,
          p.description = pkg.description,
          p.latest_version = pkg.latest_version,
          p.weekly_downloads = pkg.weekly_downloads
      MERGE (v:Version {package_name: pkg.name, version_number: pkg.latest_version})
      SET v.deprecated = false, v.release_date = date()
      MERGE (p)-[:HAS_VERSION]->(v)
      `,
      { packages }
    );

    // Dependency edges: Version -[:DEPENDS_ON]-> Package
    await session.run(
      `
      UNWIND $edges AS e
      MATCH (fromP:Package {name: e.from})-[:HAS_VERSION]->(v:Version {package_name: e.from})
      MATCH (toP:Package {name: e.to})
      MERGE (v)-[r:DEPENDS_ON]->(toP)
      SET r.version_range = '^' + toP.name
      `,
      { edges: dependsOn }
    );

    // Maintainer nodes + MAINTAINS edges
    await session.run(
      `
      UNWIND $rows AS row
      MERGE (m:Maintainer {username: row.username})
      SET m.email_domain = 'users.example.com'
      WITH m, row
      MATCH (p:Package {name: row.packageName})
      MERGE (m)-[r:MAINTAINS]->(p)
      SET r.since = date(row.since)
      `,
      { rows: maintains }
    );

    // Vulnerabilities
    await session.run(
      `
      UNWIND $vulns AS vln
      MERGE (vu:Vulnerability {cve_id: vln.cve_id})
      SET vu.severity = vln.severity, vu.published_date = date(vln.published_date)
      WITH vu, vln
      MATCH (p:Package {name: vln.packageName})-[:HAS_VERSION]->(v:Version)
      MERGE (v)-[:AFFECTED_BY]->(vu)
      `,
      { vulns }
    );

    console.log('Seed complete.');
  } finally {
    await session.close();
    await driver.close();
  }
}

main().catch((err) => {
  console.error('Seed failed:', err.message);
  process.exit(1);
});
