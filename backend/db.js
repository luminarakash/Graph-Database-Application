// db.js
// Thin wrapper around the official Neo4j driver, pointed at a CognoDB Cloud instance.
// CognoDB speaks openCypher over Bolt 5.x, so the standard neo4j-driver works unmodified -
// no custom SDK needed.

const neo4j = require('neo4j-driver');
require('dotenv').config();

const { COGNODB_URI, COGNODB_USER, COGNODB_PASSWORD } = process.env;

let driver = null;
let connectionError = null;

function getDriver() {
  if (driver) return driver;

  if (!COGNODB_URI || !COGNODB_USER || !COGNODB_PASSWORD) {
    connectionError = new Error(
      'Missing CognoDB connection details. Copy backend/.env.example to backend/.env ' +
      'and fill in COGNODB_URI, COGNODB_USER, COGNODB_PASSWORD.'
    );
    throw connectionError;
  }

  driver = neo4j.driver(
    COGNODB_URI,
    neo4j.auth.basic(COGNODB_USER, COGNODB_PASSWORD),
    { maxConnectionPoolSize: 20 }
  );
  return driver;
}

// Runs a single parameterised Cypher query and returns plain JS records.
// Every query in this app goes through here so nothing is ever string-concatenated.
async function runQuery(cypher, params = {}) {
  const session = getDriver().session();
  try {
    const result = await session.run(cypher, params);
    return result.records.map((record) => record.toObject());
  } finally {
    await session.close();
  }
}

// Used by the /api/health route and by server startup to fail gracefully
// instead of crashing when CognoDB is unreachable.
async function checkConnection() {
  try {
    await getDriver().verifyConnectivity();
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}

async function closeDriver() {
  if (driver) await driver.close();
}

module.exports = { getDriver, runQuery, checkConnection, closeDriver };
