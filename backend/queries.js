// queries.js
// Every Cypher query the app runs, in one place, fully parameterised.
// See README "Main queries explained" for plain-English descriptions of each of these.

const { runQuery } = require('./db');

// ---- Browsing ---------------------------------------------------------

async function searchPackages(search = '', limit = 30) {
  return runQuery(
    `
    MATCH (p:Package)
    WHERE toLower(p.name) CONTAINS toLower($search)
    OPTIONAL MATCH (m:Maintainer)-[:MAINTAINS]->(p)
    WITH p, count(DISTINCT m) AS maintainerCount
    RETURN p.name AS name, p.ecosystem AS ecosystem, p.description AS description,
           p.latest_version AS latestVersion, p.weekly_downloads AS weeklyDownloads,
           maintainerCount
    ORDER BY p.weekly_downloads DESC
    LIMIT $limit
    `,
    { search, limit: neo4jInt(limit) }
  );
}

async function getPackageDetail(name) {
  const rows = await runQuery(
    `
    MATCH (p:Package {name: $name})
    OPTIONAL MATCH (m:Maintainer)-[r:MAINTAINS]->(p)
    WITH p, collect(DISTINCT {username: m.username, since: toString(r.since)}) AS maintainers
    OPTIONAL MATCH (p)-[:HAS_VERSION]->(v:Version)-[:DEPENDS_ON]->(dep:Package)
    WITH p, maintainers, collect(DISTINCT dep.name) AS directDependencies
    OPTIONAL MATCH (v2:Version)-[:DEPENDS_ON]->(p)
    MATCH (dependent:Package)-[:HAS_VERSION]->(v2)
    WITH p, maintainers, directDependencies, collect(DISTINCT dependent.name) AS directDependents
    RETURN p.name AS name, p.ecosystem AS ecosystem, p.description AS description,
           p.latest_version AS latestVersion, p.weekly_downloads AS weeklyDownloads,
           maintainers, directDependencies, directDependents
    `,
    { name }
  );
  return rows[0] || null;
}

// ---- Risk query 1: bus-factor risk (multi-hop, variable-length path) --
// Packages maintained by exactly one person, ranked by how many other
// packages transitively depend on them. This is a graph-native query:
// in SQL it would require a recursive CTE walking an edge table at
// unknown depth, then a distinct count - awkward and slow at scale.

async function busFactorRisk(limit = 20) {
  return runQuery(
    `
    MATCH (m:Maintainer)-[:MAINTAINS]->(p:Package)
    WITH p, count(DISTINCT m) AS maintainerCount
    WHERE maintainerCount = 1
    OPTIONAL MATCH (dependent:Package)-[:HAS_VERSION]->(:Version)-[:DEPENDS_ON*1..5]->(p)
    WITH p, maintainerCount, count(DISTINCT dependent) AS transitiveDependents
    RETURN p.name AS name, p.ecosystem AS ecosystem, p.weekly_downloads AS weeklyDownloads,
           transitiveDependents
    ORDER BY transitiveDependents DESC
    LIMIT $limit
    `,
    { limit: neo4jInt(limit) }
  );
}

// ---- Risk query 2: blast radius ----------------------------------------
// Given a package, find every package that transitively depends on it
// within N hops, with the shortest path length to each. This is a
// variable-length shortest-path query - the kind of thing a relational
// schema needs a recursive self-join (or an app-side BFS) to answer.

async function blastRadius(name, maxHops = 4) {
  // Cypher does not support parameterising the hop-count inside a
  // variable-length relationship pattern ([:REL*1..N]), so N is validated
  // as a small integer and interpolated directly - $name (the only
  // user-supplied string) stays fully parameterised.
  const hops = Math.min(Math.max(parseInt(maxHops, 10) || 4, 1), 8);
  return runQuery(
    `
    MATCH (target:Package {name: $name})
    MATCH path = (dependent:Package)-[:HAS_VERSION]->(:Version)-[:DEPENDS_ON*1..${hops}]->(target)
    WITH dependent, min(length(path)) AS pathHops
    RETURN dependent.name AS name, pathHops AS hops
    ORDER BY hops ASC, name ASC
    `,
    { name }
  );
}

// ---- Risk query 3: deepest dependency chains ---------------------------
// Finds the longest DEPENDS_ON chain in the graph - a "how deep does the
// rabbit hole go" query, again variable-length and awkward in SQL.

async function deepestChains(limit = 5) {
  return runQuery(
    `
    MATCH path = (p:Package)-[:HAS_VERSION]->(:Version)-[:DEPENDS_ON*1..8]->(:Package)
    WITH path, length(path) AS depth
    ORDER BY depth DESC
    LIMIT $limit
    RETURN [n IN nodes(path) WHERE n:Package | n.name] AS chain, depth
    `,
    { limit: neo4jInt(limit) }
  );
}

// ---- Risk query 4: shared-risk clusters --------------------------------
// Packages that share a maintainer with a package that has a known
// vulnerability - i.e. "if this maintainer's account were compromised,
// what else is at risk", a join across two hops of shared identity.

async function sharedRiskClusters(limit = 20) {
  return runQuery(
    `
    MATCH (vulnPkg:Package)-[:HAS_VERSION]->(:Version)-[:AFFECTED_BY]->(vuln:Vulnerability)
    MATCH (m:Maintainer)-[:MAINTAINS]->(vulnPkg)
    MATCH (m)-[:MAINTAINS]->(sharedPkg:Package)
    WHERE sharedPkg <> vulnPkg
    RETURN DISTINCT sharedPkg.name AS relatedPackage, vulnPkg.name AS vulnerablePackage,
           vuln.cve_id AS cveId, vuln.severity AS severity, m.username AS sharedMaintainer
    ORDER BY severity DESC
    LIMIT $limit
    `,
    { limit: neo4jInt(limit) }
  );
}

// ---- Risk query 5: orphan risk ------------------------------------------
// If a given maintainer stopped maintaining everything, which packages
// would be left with zero maintainers?

async function orphanRisk(username) {
  return runQuery(
    `
    MATCH (m:Maintainer {username: $username})-[:MAINTAINS]->(p:Package)
    OPTIONAL MATCH (other:Maintainer)-[:MAINTAINS]->(p)
    WHERE other <> m
    WITH p, count(other) AS otherMaintainers
    WHERE otherMaintainers = 0
    RETURN p.name AS name, p.ecosystem AS ecosystem, p.weekly_downloads AS weeklyDownloads
    ORDER BY p.weekly_downloads DESC
    `,
    { username }
  );
}

async function listMaintainers(limit = 30) {
  return runQuery(
    `
    MATCH (m:Maintainer)-[:MAINTAINS]->(p:Package)
    WITH m, count(p) AS packageCount
    RETURN m.username AS username, packageCount
    ORDER BY packageCount DESC
    LIMIT $limit
    `,
    { limit: neo4jInt(limit) }
  );
}

// Helper: neo4j-driver wants integers as neo4j.int for LIMIT/range params.
const neo4j = require('neo4j-driver');
function neo4jInt(n) {
  return neo4j.int(n);
}

module.exports = {
  searchPackages,
  getPackageDetail,
  busFactorRisk,
  blastRadius,
  deepestChains,
  sharedRiskClusters,
  orphanRisk,
  listMaintainers,
};
