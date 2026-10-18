const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { Resend } = require('resend');
const db = require('./database');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5050;

// Initialize Resend with secure API key from environment
const resendApiKey = process.env.RESEND_API_KEY;
const resendFromEmail = process.env.RESEND_FROM_EMAIL || 'OmniTranslate <onboarding@resend.dev>';
const resendClient = resendApiKey ? new Resend(resendApiKey) : null;

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
    uptime: Math.round(process.uptime()),
    hasResend: Boolean(resendClient)
  });
});

// Resolves recipient email for Resend delivery:
// Resend testing sandbox with onboarding@resend.dev requires exact match for the account owner (ninotura.kura@gmail.com).
// Gmail ignores dots (ninoturakura@gmail.com and ninotura.kura@gmail.com deliver to the same inbox).
function getResendDeliveryRecipient(email) {
  if (!email) return 'ninotura.kura@gmail.com';
  const clean = email.toLowerCase().trim();
  const [user, domain] = clean.split('@');

  // Handle Gmail dot normalization for ninoturakura
  if (domain === 'gmail.com' && user && user.replace(/\./g, '') === 'ninoturakura') {
    return 'ninotura.kura@gmail.com';
  }

  // If using default onboarding@resend.dev test domain, Resend requires account owner address
  if (resendFromEmail.includes('resend.dev')) {
    return 'ninotura.kura@gmail.com';
  }

  return clean;
}

// 2. Real Email Verification: Send 6-Digit OTP Code via Resend
app.post('/api/auth/send-code', async (req, res) => {
  try {
    const { email, displayName } = req.body;
    if (!email || !email.includes('@')) {
      return res.status(400).json({ error: 'A valid email address is required.' });
    }

    const cleanEmail = email.toLowerCase().trim();
    // Generate secure 6-digit verification code
    const code = Math.floor(100000 + Math.random() * 900000).toString();

    // Store in PostgreSQL database (expires in 10 minutes)
    await db.saveVerificationCode(cleanEmail, code, displayName);

    let emailDelivered = false;
    let resendNotice = '';

    if (resendClient) {
      try {
        const deliveryEmail = getResendDeliveryRecipient(cleanEmail);
        const subject = (deliveryEmail !== cleanEmail)
          ? `${code} is the OmniTranslate verification code for ${cleanEmail}`
          : `${code} is your OmniTranslate verification code`;

        const sendResult = await resendClient.emails.send({
          from: resendFromEmail,
          to: deliveryEmail,
          subject,
          html: `
            <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #070B14; color: #FFFFFF; padding: 40px 24px; border-radius: 16px; max-width: 500px; margin: 0 auto; box-shadow: 0 10px 30px rgba(0,0,0,0.5);">
              <div style="text-align: center; margin-bottom: 24px;">
                <span style="display: inline-block; background: rgba(0, 245, 212, 0.15); border: 1px solid rgba(0, 245, 212, 0.4); color: #00F5D4; font-size: 13px; font-weight: 800; padding: 4px 14px; border-radius: 20px; letter-spacing: 1px; text-transform: uppercase;">
                  ⚡ OmniTranslate Live
                </span>
                <h1 style="font-size: 24px; font-weight: 800; color: #FFFFFF; margin: 16px 0 6px;">Sign In Verification Code</h1>
                <p style="color: #94A3B8; font-size: 14px; margin: 0;">Use the code below to sign in for <strong style="color: #00F5D4;">${cleanEmail}</strong>.</p>
              </div>

              <div style="background: rgba(13, 22, 40, 0.9); border: 2px dashed #00F5D4; border-radius: 14px; padding: 24px; text-align: center; margin-bottom: 24px;">
                <span style="font-size: 38px; font-weight: 900; letter-spacing: 10px; color: #00F5D4; font-family: 'Courier New', Courier, monospace; display: inline-block;">${code}</span>
              </div>

              <div style="background: rgba(255, 255, 255, 0.05); border-radius: 10px; padding: 14px; margin-bottom: 20px;">
                <p style="color: #CBD5E1; font-size: 13px; line-height: 1.5; margin: 0;">
                  ⏱️ <strong>Valid for 10 minutes</strong>. Do not share this code with anyone.
                </p>
              </div>

              <p style="color: #64748B; font-size: 11.5px; text-align: center; margin: 0;">
                If you did not request this verification code, please disregard this email.
              </p>
            </div>
          `
        });

        if (sendResult?.data && !sendResult?.error) {
          emailDelivered = true;
          console.log(`✅ [Resend] Verification code sent to ${cleanEmail}`);
        } else if (sendResult?.error) {
          console.warn(`⚠️ [Resend Notice]:`, sendResult.error.message);
          resendNotice = sendResult.error.message;
        }
      } catch (sendErr) {
        console.warn(`⚠️ [Resend Send Error]:`, sendErr.message);
        resendNotice = sendErr.message;
      }
    } else {
      console.warn('⚠️ [Auth] No Resend API client configured.');
    }

    return res.json({
      success: true,
      message: emailDelivered 
        ? `Verification code sent to ${cleanEmail}! Please check your email inbox.` 
        : `Verification code generated! ${resendNotice ? '(Resend Sandbox notice: ' + resendNotice + ')' : ''}`,
      emailDelivered,
      // Provide devCode in development mode or if Resend sandbox restricts domain recipient
      devCode: (!emailDelivered || process.env.NODE_ENV === 'development') ? code : undefined
    });
  } catch (err) {
    console.error('Error in /api/auth/send-code:', err);
    return res.status(500).json({ error: err.message });
  }
});

// 2b. Verify Code & Authenticate User
app.post('/api/auth/verify-code', async (req, res) => {
  try {
    const { email, code, platform = 'desktop' } = req.body;
    if (!email || !code) {
      return res.status(400).json({ error: 'Email and verification code are required.' });
    }

    const user = await db.verifyCode({ email, code, platform });
    const permission = await db.checkUsagePermission(user.email);

    return res.json({
      success: true,
      message: user.isDeveloper 
        ? 'Verified with Developer privileges' 
        : 'Email verified successfully',
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
    console.error('Error in /api/auth/verify-code:', err.message);
    return res.status(400).json({ error: err.message });
  }
});

// 2c. Register Account: Send 6-Digit Email Verification Code via Resend
app.post('/api/auth/register-send-code', async (req, res) => {
  try {
    const { email, password, displayName } = req.body;
    if (!email || !email.includes('@')) {
      return res.status(400).json({ error: 'A valid email address is required.' });
    }
    if (!password || password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    }

    const cleanEmail = email.toLowerCase().trim();
    const existing = await db.getUser(cleanEmail);
    const isExistingAccount = Boolean(existing && existing.hasPassword);

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const passwordHash = db.hashPassword(password);

    await db.saveRegistrationCode({
      email: cleanEmail,
      code,
      displayName: displayName || cleanEmail.split('@')[0],
      passwordHash
    });

    let emailDelivered = false;
    let resendNotice = '';

    if (resendClient) {
      try {
        const deliveryEmail = getResendDeliveryRecipient(cleanEmail);
        const subject = (deliveryEmail !== cleanEmail)
          ? `${code} is the OmniTranslate verification code for ${cleanEmail}`
          : `${code} is your OmniTranslate account verification code`;

        const sendResult = await resendClient.emails.send({
          from: resendFromEmail,
          to: deliveryEmail,
          subject,
          html: `
            <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #070B14; color: #FFFFFF; padding: 40px 24px; border-radius: 16px; max-width: 500px; margin: 0 auto; box-shadow: 0 10px 30px rgba(0,0,0,0.5);">
              <div style="text-align: center; margin-bottom: 24px;">
                <span style="display: inline-block; background: rgba(0, 245, 212, 0.15); border: 1px solid rgba(0, 245, 212, 0.4); color: #00F5D4; font-size: 13px; font-weight: 800; padding: 4px 14px; border-radius: 20px; letter-spacing: 1px; text-transform: uppercase;">
                  ⚡ OmniTranslate Registration
                </span>
                <h1 style="font-size: 24px; font-weight: 800; color: #FFFFFF; margin: 16px 0 6px;">Verify Your Account</h1>
                <p style="color: #94A3B8; font-size: 14px; margin: 0;">Welcome to OmniTranslate! Enter the 6-digit code below to activate account for <strong style="color: #00F5D4;">${cleanEmail}</strong>.</p>
              </div>

              <div style="background: rgba(13, 22, 40, 0.9); border: 2px dashed #00F5D4; border-radius: 14px; padding: 24px; text-align: center; margin-bottom: 24px;">
                <span style="font-size: 38px; font-weight: 900; letter-spacing: 10px; color: #00F5D4; font-family: 'Courier New', Courier, monospace; display: inline-block;">${code}</span>
              </div>

              <div style="background: rgba(255, 255, 255, 0.05); border-radius: 10px; padding: 14px; margin-bottom: 20px;">
                <p style="color: #CBD5E1; font-size: 13px; line-height: 1.5; margin: 0;">
                  ⏱️ <strong>Valid for 10 minutes</strong>. Do not share this code with anyone.
                </p>
              </div>

              <p style="color: #64748B; font-size: 11.5px; text-align: center; margin: 0;">
                If you did not request to create an OmniTranslate account, you can safely ignore this email.
              </p>
            </div>
          `
        });

        if (sendResult?.data && !sendResult?.error) {
          emailDelivered = true;
          console.log(`✅ [Resend] Registration verification code sent to ${deliveryEmail} (for ${cleanEmail})`);
        } else if (sendResult?.error) {
          console.warn(`⚠️ [Resend Notice]:`, sendResult.error.message);
          resendNotice = sendResult.error.message;
        }
      } catch (sendErr) {
        console.warn(`⚠️ [Resend Send Error]:`, sendErr.message);
        resendNotice = sendErr.message;
      }
    }

    return res.json({
      success: true,
      message: emailDelivered
        ? `Verification code sent to ${cleanEmail}! Please check your email inbox.`
        : `Verification code generated! ${resendNotice ? '(Resend Sandbox notice: ' + resendNotice + ')' : ''}`,
      emailDelivered,
      devCode: (!emailDelivered || process.env.NODE_ENV === 'development') ? code : undefined
    });
  } catch (err) {
    console.error('Error in /api/auth/register-send-code:', err);
    return res.status(500).json({ error: err.message });
  }
});

// 2d. Verify Registration Code & Create Account
app.post('/api/auth/verify-registration', async (req, res) => {
  try {
    const { email, code, platform = 'desktop' } = req.body;
    if (!email || !code) {
      return res.status(400).json({ error: 'Email and verification code are required.' });
    }

    const user = await db.verifyRegistration({ email, code, platform });
    const permission = await db.checkUsagePermission(user.email);

    return res.json({
      success: true,
      message: 'Account verified and registered successfully!',
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
    console.error('Error in /api/auth/verify-registration:', err.message);
    return res.status(400).json({ error: err.message });
  }
});

// 2e. Direct Email & Password Registration (Optional/Fallback)
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, displayName, platform = 'desktop' } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const user = await db.registerUser({
      email,
      password,
      displayName,
      platform
    });

    const permission = await db.checkUsagePermission(email);

    return res.json({
      success: true,
      message: 'Account registered successfully',
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
    console.error('Error in /api/auth/register:', err.message);
    return res.status(400).json({ error: err.message });
  }
});

// 2c. Email & Password Login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const user = await db.loginUser({
      email,
      password
    });

    const permission = await db.checkUsagePermission(email);

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
    console.error('Error in /api/auth/login:', err.message);
    return res.status(401).json({ error: err.message });
  }
});

// 3. User Profile & Permission Check
app.get('/api/user/profile', async (req, res) => {
  try {
    const email = req.query.email || req.headers['x-user-email'];
    if (!email) {
      return res.status(400).json({ error: 'email query parameter is required' });
    }

    let user = await db.getUser(email);
    if (!user) {
      user = await db.findOrCreateUser({ email });
    }

    const permission = await db.checkUsagePermission(email);

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
app.post('/api/usage/record', async (req, res) => {
  try {
    const { email, seconds = 3, chars = 0, platform = 'desktop' } = req.body;
    if (!email) {
      return res.status(400).json({ error: 'email is required to record usage' });
    }

    const result = await db.recordUsage({
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
app.post('/api/user/toggle-developer-bypass', async (req, res) => {
  try {
    const { email, enabled } = req.body;
    if (!email) {
      return res.status(400).json({ error: 'email is required' });
    }

    const permission = await db.toggleDeveloperBypass(email, enabled);
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
app.post('/api/user/upgrade', async (req, res) => {
  try {
    const { email, tier = 'pro' } = req.body;
    if (!email) {
      return res.status(400).json({ error: 'email is required' });
    }

    const user = await db.setTier(email, tier);
    const permission = await db.checkUsagePermission(email);

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
app.get('/api/metrics/summary', async (req, res) => {
  try {
    const metrics = await db.getPlatformMetrics();
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
async function startServer() {
  if (db.initPromise) {
    try {
      await db.initPromise;
    } catch (e) {
      console.warn('⚠️ [DB] Warning during startup:', e.message);
    }
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`=======================================================`);
    console.log(`🚀 OmniTranslate Shared Backend running on port ${PORT}`);
    console.log(`📡 Local URL: http://localhost:${PORT}`);
    console.log(`🔐 Developer accounts active with automatic bypass`);
    console.log(`=======================================================`);
  });
}

startServer();

module.exports = app;
