const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const { checkConnection, closeDriver } = require('./db');
const queries = require('./queries');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Wraps every route so a CognoDB outage returns a clean JSON error instead
// of an unhandled exception / stack trace.
function safeRoute(handler) {
  return async (req, res) => {
    try {
      const data = await handler(req, res);
      res.json(data);
    } catch (err) {
      console.error(err);
      res.status(503).json({
        error: 'database_unreachable',
        message:
          'DepTrust could not reach the CognoDB instance. Check that the instance is ' +
          'running and that COGNODB_URI / COGNODB_USER / COGNODB_PASSWORD in .env are correct.',
        detail: err.message,
      });
    }
  };
}

app.get('/api/health', async (req, res) => {
  const status = await checkConnection();
  res.status(status.ok ? 200 : 503).json(status);
});

app.get('/api/packages', safeRoute((req) => queries.searchPackages(req.query.q || '', 40)));

app.get('/api/packages/:name', safeRoute(async (req) => {
  const pkg = await queries.getPackageDetail(req.params.name);
  if (!pkg) {
    const err = new Error('Package not found');
    err.status = 404;
    throw err;
  }
  return pkg;
}));

app.get('/api/packages/:name/blast-radius', safeRoute((req) =>
  queries.blastRadius(req.params.name, req.query.hops)
));

app.get('/api/risk/bus-factor', safeRoute(() => queries.busFactorRisk(20)));
app.get('/api/risk/deepest-chains', safeRoute(() => queries.deepestChains(5)));
app.get('/api/risk/shared-clusters', safeRoute(() => queries.sharedRiskClusters(20)));
app.get('/api/risk/orphan/:username', safeRoute((req) => queries.orphanRisk(req.params.username)));
app.get('/api/maintainers', safeRoute(() => queries.listMaintainers(30)));

// Serve the static frontend
app.use(express.static(path.join(__dirname, '..', 'frontend')));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, '..', 'frontend', 'index.html'));
});

app.listen(PORT, async () => {
  console.log(`DepTrust server running on http://localhost:${PORT}`);
  const status = await checkConnection();
  if (!status.ok) {
    console.warn(
      `WARNING: could not connect to CognoDB at startup (${status.message}). ` +
      `The app will still serve the UI but API calls will return 503 until the DB is reachable.`
    );
  } else {
    console.log('Connected to CognoDB.');
  }
});

process.on('SIGINT', async () => {
  await closeDriver();
  process.exit(0);
});
