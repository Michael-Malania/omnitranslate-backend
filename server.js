const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const db = require('./database');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5050;

// Enable CORS for all clients (Web, Electron Desktop, Android Mobile, Localhost)
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-client-platform']
}));

app.use(express.json());

// Request logger
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    if (req.path !== '/api/health') {
      console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${duration}ms)`);
    }
  });
  next();
});

// 1. Health & Status
app.get(['/', '/api/health'], (req, res) => {
  res.json({
    status: 'ok',
    service: 'OmniTranslate Shared Backend API',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    uptime: Math.round(process.uptime())
  });
});

// 2. Google Authentication & Profile Sync
app.post('/api/auth/google', (req, res) => {
  try {
    const { email, displayName, photoUrl, platform = 'desktop' } = req.body;
    if (!email) {
      return res.status(400).json({ error: 'Email is required for Google Sign-In' });
    }

    const user = db.findOrCreateUser({
      email,
      displayName,
      photoUrl,
      platform
    });

    const permission = db.checkUsagePermission(email);

    return res.json({
      success: true,
      message: user.isDeveloper 
        ? 'Signed in with Developer privileges' 
        : 'Signed in successfully',
      user: {
        email: user.email,
        displayName: user.displayName,
        photoUrl: user.photoUrl,
        role: user.role,
        tier: user.tier,
        isDeveloper: user.isDeveloper,
        isPaid: user.isPaid,
        developerBypass: user.developerBypass,
        usage: user.usage
      },
      permission
    });
  } catch (err) {
    console.error('Error in /api/auth/google:', err);
    return res.status(500).json({ error: err.message });
  }
});

// 3. User Profile & Permission Check
app.get('/api/user/profile', (req, res) => {
  try {
    const email = req.query.email || req.headers['x-user-email'];
    if (!email) {
      return res.status(400).json({ error: 'email query parameter is required' });
    }

    let user = db.getUser(email);
    if (!user) {
      user = db.findOrCreateUser({ email });
    }

    const permission = db.checkUsagePermission(email);

    return res.json({
      success: true,
      user: {
        email: user.email,
        displayName: user.displayName,
        photoUrl: user.photoUrl,
        role: user.role,
        tier: user.tier,
        isDeveloper: user.isDeveloper,
        isPaid: user.isPaid,
        developerBypass: user.developerBypass,
        usage: user.usage
      },
      permission
    });
  } catch (err) {
    console.error('Error in /api/user/profile:', err);
    return res.status(500).json({ error: err.message });
  }
});

// 4. Record Usage (Triggered on Translation)
app.post('/api/usage/record', (req, res) => {
  try {
    const { email, seconds = 3, chars = 0, platform = 'desktop' } = req.body;
    if (!email) {
      return res.status(400).json({ error: 'email is required to record usage' });
    }

    const result = db.recordUsage({
      email,
      seconds,
      chars,
      platform
    });

    if (!result.allowed) {
      return res.status(403).json(result);
    }

    return res.json(result);
  } catch (err) {
    console.error('Error in /api/usage/record:', err);
    return res.status(500).json({ error: err.message });
  }
});

// 5. Developer Mode Toggle (Turn off / on metrics)
app.post('/api/user/toggle-developer-bypass', (req, res) => {
  try {
    const { email, enabled } = req.body;
    if (!email) {
      return res.status(400).json({ error: 'email is required' });
    }

    const permission = db.toggleDeveloperBypass(email, enabled);
    return res.json({
      success: true,
      message: `Developer bypass ${enabled ? 'ENABLED (unlimited)' : 'DISABLED (simulating regular user)'}`,
      permission
    });
  } catch (err) {
    console.error('Error in /api/user/toggle-developer-bypass:', err);
    return res.status(403).json({ error: err.message });
  }
});

// 6. Upgrade Tier (Paywall checkout completion)
app.post('/api/user/upgrade', (req, res) => {
  try {
    const { email, tier = 'pro' } = req.body;
    if (!email) {
      return res.status(400).json({ error: 'email is required' });
    }

    const user = db.setTier(email, tier);
    const permission = db.checkUsagePermission(email);

    return res.json({
      success: true,
      message: `Account successfully upgraded to ${tier.toUpperCase()}`,
      user,
      permission
    });
  } catch (err) {
    console.error('Error in /api/user/upgrade:', err);
    return res.status(500).json({ error: err.message });
  }
});

// 7. Platform Aggregate Metrics
app.get('/api/metrics/summary', (req, res) => {
  try {
    const metrics = db.getPlatformMetrics();
    return res.json({
      success: true,
      metrics
    });
  } catch (err) {
    console.error('Error in /api/metrics/summary:', err);
    return res.status(500).json({ error: err.message });
  }
});

// Start Server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`=======================================================`);
  console.log(`🚀 OmniTranslate Shared Backend running on port ${PORT}`);
  console.log(`📡 Local URL: http://localhost:${PORT}`);
  console.log(`🔐 Developer accounts active with automatic bypass`);
  console.log(`=======================================================`);
});

module.exports = app;
