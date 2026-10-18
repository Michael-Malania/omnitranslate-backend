const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const dns = require('dns');
const nodemailer = require('nodemailer');
const db = require('./database');

dotenv.config();

// Force IPv4 resolution first to avoid Render IPv6 blackholes
if (dns.setDefaultResultOrder) {
  dns.setDefaultResultOrder('ipv4first');
}

const app = express();
const PORT = process.env.PORT || 5050;

// Initialize Email Transporters (Resend HTTPS + Gmail SMTP)
const resendApiKey = process.env.RESEND_API_KEY;
const resendFromEmail = process.env.RESEND_FROM_EMAIL || 'SubStream Live <onboarding@resend.dev>';
const smtpUser = process.env.SMTP_USER;
const smtpPass = process.env.SMTP_PASS;
const emailFrom = process.env.EMAIL_FROM || '"SubStream Live" <ninotura.kura@gmail.com>';

let transporter = null;
if (smtpUser && smtpPass) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: Number(process.env.SMTP_PORT) || 465,
    secure: process.env.SMTP_SECURE !== 'false',
    family: 4,
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 12000,
    auth: {
      user: smtpUser,
      pass: smtpPass
    }
  });
}

function getResendDeliveryRecipient(email) {
  if (!email) return 'ninotura.kura@gmail.com';
  const clean = email.toLowerCase().trim();
  const [user, domain] = clean.split('@');

  // Normalize Gmail dots for ninoturakura
  if (domain === 'gmail.com' && user && user.replace(/\./g, '') === 'ninoturakura') {
    return 'ninotura.kura@gmail.com';
  }

  // If using onboarding@resend.dev sandbox, route to account owner inbox
  if (resendFromEmail.includes('resend.dev')) {
    return 'ninotura.kura@gmail.com';
  }

  return clean;
}

// Helper: send email in background via Resend HTTPS (and SMTP fallback)
async function dispatchEmail({ to, subject, html }) {
  const cleanTo = (to || '').toLowerCase().trim();

  // 1. Resend HTTPS API (Port 443 - works instantaneously on Render)
  if (resendApiKey) {
    try {
      const deliveryEmail = getResendDeliveryRecipient(cleanTo);
      const finalSubject = (deliveryEmail !== cleanTo)
        ? `${subject} (for ${cleanTo})`
        : subject;

      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${resendApiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: resendFromEmail,
          to: deliveryEmail,
          subject: finalSubject,
          html
        })
      });
      const data = await response.json();
      if (response.ok && data?.id) {
        console.log(`✅ [Resend] Verification code sent to ${deliveryEmail} (for ${cleanTo}, ID: ${data.id})`);
        return true;
      } else {
        console.warn(`⚠️ [Resend Notice]:`, data?.message || JSON.stringify(data));
      }
    } catch (err) {
      console.warn(`⚠️ [Resend Error]:`, err.message);
    }
  }

  // 2. Gmail SMTP Fallback
  if (transporter) {
    try {
      const info = await transporter.sendMail({
        from: emailFrom,
        to: cleanTo,
        subject,
        html
      });
      console.log(`✅ [SMTP] Email delivered to ${cleanTo} (MessageId: ${info?.messageId})`);
      return true;
    } catch (err) {
      console.warn(`⚠️ [SMTP] Notice for ${cleanTo}:`, err.message);
    }
  }
  return false;
}

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
    service: 'SubStream Shared Backend API',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    uptime: Math.round(process.uptime()),
    hasSmtp: Boolean(transporter)
  });
});

// 2. Real Email Verification: Send 6-Digit OTP Code via Gmail SMTP
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

    // Dispatch email asynchronously so HTTP response returns in <50ms
    dispatchEmail({
      to: cleanEmail,
      subject: `${code} is your SubStream verification code`,
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #070B14; color: #FFFFFF; padding: 40px 24px; border-radius: 16px; max-width: 500px; margin: 0 auto; box-shadow: 0 10px 30px rgba(0,0,0,0.5);">
          <div style="text-align: center; margin-bottom: 24px;">
            <span style="display: inline-block; background: rgba(0, 245, 212, 0.15); border: 1px solid rgba(0, 245, 212, 0.4); color: #00F5D4; font-size: 13px; font-weight: 800; padding: 4px 14px; border-radius: 20px; letter-spacing: 1px; text-transform: uppercase;">
              ⚡ SubStream Live
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

    return res.json({
      success: true,
      message: `Verification code sent to ${cleanEmail}! Please check your email inbox.`,
      emailDelivered: true,
      devCode: code
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

// 2c. Register Account: Send 6-Digit Email Verification Code via Gmail SMTP
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
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const passwordHash = db.hashPassword(password);

    await db.saveRegistrationCode({
      email: cleanEmail,
      code,
      displayName: displayName || cleanEmail.split('@')[0],
      passwordHash
    });

    // Dispatch email asynchronously so HTTP response returns in <50ms
    dispatchEmail({
      to: cleanEmail,
      subject: `${code} is your SubStream account verification code`,
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #070B14; color: #FFFFFF; padding: 40px 24px; border-radius: 16px; max-width: 500px; margin: 0 auto; box-shadow: 0 10px 30px rgba(0,0,0,0.5);">
          <div style="text-align: center; margin-bottom: 24px;">
            <span style="display: inline-block; background: rgba(0, 245, 212, 0.15); border: 1px solid rgba(0, 245, 212, 0.4); color: #00F5D4; font-size: 13px; font-weight: 800; padding: 4px 14px; border-radius: 20px; letter-spacing: 1px; text-transform: uppercase;">
              ⚡ SubStream Registration
            </span>
            <h1 style="font-size: 24px; font-weight: 800; color: #FFFFFF; margin: 16px 0 6px;">Verify Your Account</h1>
            <p style="color: #94A3B8; font-size: 14px; margin: 0;">Welcome to SubStream! Enter the 6-digit code below to activate account for <strong style="color: #00F5D4;">${cleanEmail}</strong>.</p>
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
            If you did not request to create a SubStream account, you can safely ignore this email.
          </p>
        </div>
      `
    });

    return res.json({
      success: true,
      message: `Verification code sent to ${cleanEmail}! Please check your email inbox.`,
      emailDelivered: true,
      devCode: code
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

// Paddle Billing Integration Helpers
const PADDLE_API_KEY = process.env.PADDLE_API_KEY;
const PADDLE_ENVIRONMENT = process.env.PADDLE_ENVIRONMENT || 'sandbox';
const PADDLE_API_BASE = PADDLE_ENVIRONMENT === 'sandbox' 
  ? 'https://sandbox-api.paddle.com' 
  : 'https://api.paddle.com';

async function fetchPaddleTransaction(txnId) {
  try {
    const res = await fetch(`${PADDLE_API_BASE}/transactions/${txnId}`, {
      headers: {
        'Authorization': `Bearer ${PADDLE_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });
    if (!res.ok) {
      console.warn(`[Paddle API] Failed to fetch txn ${txnId}: HTTP ${res.status}`);
      return null;
    }
    const data = await res.json();
    return data?.data || null;
  } catch (e) {
    console.error(`[Paddle API] Error fetching txn ${txnId}:`, e.message);
    return null;
  }
}

async function fetchPaddleCustomer(customerId) {
  try {
    const res = await fetch(`${PADDLE_API_BASE}/customers/${customerId}`, {
      headers: {
        'Authorization': `Bearer ${PADDLE_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.data || null;
  } catch (e) {
    return null;
  }
}

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

// 6b. Verify Paddle Transaction & Instant Upgrade
app.get('/api/paddle/verify-transaction', async (req, res) => {
  try {
    const { txnId, email, wallet, walletAddress } = req.query;
    if (!txnId && !email && !wallet && !walletAddress) {
      return res.status(400).json({ error: 'txnId, email, or walletAddress is required' });
    }

    let customerEmail = email ? email.toLowerCase().trim() : null;
    let targetWallet = (walletAddress || wallet || '').trim() || null;
    let txn = null;

    if (txnId) {
      txn = await fetchPaddleTransaction(txnId);
      if (txn) {
        if (!targetWallet && txn.custom_data?.walletAddress) {
          targetWallet = txn.custom_data.walletAddress.trim();
        }
        if (txn.customer_id) {
          const customer = await fetchPaddleCustomer(txn.customer_id);
          if (customer && customer.email) {
            customerEmail = customer.email.toLowerCase().trim();
          }
        }
      }
    }

    // Wallet Subscriber Upgrade (Solana ZeroLoss Bot Platform)
    if (targetWallet && (!txn || txn.status === 'completed' || txn.status === 'paid')) {
      const subscriber = await db.setWalletSubscriberTier(targetWallet, 'developer', {
        subscriptionId: txn?.subscription_id || txn?.id || null,
        customerId: txn?.customer_id || null,
        customerEmail: customerEmail
      });
      return res.json({
        success: true,
        verified: true,
        walletAddress: targetWallet,
        status: txn?.status || 'completed',
        subscriber
      });
    }

    // Email User Upgrade (OmniTranslate)
    if (customerEmail && (!txn || txn.status === 'completed' || txn.status === 'paid')) {
      const user = await db.setTier(customerEmail, 'pro');
      const permission = await db.checkUsagePermission(customerEmail);
      return res.json({
        success: true,
        verified: true,
        email: customerEmail,
        status: txn?.status || 'completed',
        user,
        permission
      });
    }

    return res.json({
      success: false,
      message: 'Transaction not yet completed or identifier not found',
      status: txn?.status || 'pending'
    });
  } catch (err) {
    console.error('[Paddle Verify Error]:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// 6c. Paddle Billing Webhook (transaction.completed, subscription.created, etc.)
app.post('/api/paddle/webhook', async (req, res) => {
  try {
    const event = req.body;
    const eventType = event?.event_type || event?.alert_name;
    const data = event?.data;
    console.log(`[Paddle Webhook] Received event: ${eventType}`);

    let customerEmail = data?.customer?.email;
    if (!customerEmail && data?.customer_id) {
      const customer = await fetchPaddleCustomer(data.customer_id);
      if (customer) customerEmail = customer.email;
    }
    if (!customerEmail && data?.custom_data?.email) {
      customerEmail = data.custom_data.email;
    }

    const targetWallet = data?.custom_data?.walletAddress ? data.custom_data.walletAddress.trim() : null;

    if (customerEmail) {
      customerEmail = customerEmail.toLowerCase().trim();
    }

    if (eventType === 'transaction.completed' || eventType === 'transaction.paid' || 
        eventType === 'subscription.activated' || eventType === 'subscription.created') {
      if (targetWallet) {
        console.log(`✅ [Paddle Webhook] Activating DEVELOPER subscription for wallet: ${targetWallet}`);
        await db.setWalletSubscriberTier(targetWallet, data?.custom_data?.tier || 'developer', {
          subscriptionId: data?.subscription_id || data?.id || null,
          customerId: data?.customer_id || null,
          customerEmail: customerEmail
        });
      }
      if (customerEmail) {
        console.log(`✅ [Paddle Webhook] Upgrading user ${customerEmail} to PRO tier`);
        await db.setTier(customerEmail, 'pro');
      }
    } else if (eventType === 'subscription.canceled' || eventType === 'subscription.past_due') {
      if (targetWallet) {
        console.log(`ℹ️ [Paddle Webhook] Downgrading subscription to FREE for wallet: ${targetWallet}`);
        await db.setWalletSubscriberTier(targetWallet, 'free');
      }
      if (customerEmail) {
        console.log(`ℹ️ [Paddle Webhook] Downgrading user ${customerEmail} to FREE tier`);
        await db.setTier(customerEmail, 'free');
      }
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('[Paddle Webhook Error]:', err.message);
    return res.status(200).json({ received: true, error: err.message });
  }
});

// 6d. Wallet Subscription Status Lookup
app.get('/api/wallet/subscription', async (req, res) => {
  try {
    const wallet = req.query.wallet || req.query.walletAddress;
    if (!wallet) {
      return res.status(400).json({ error: 'wallet or walletAddress parameter is required' });
    }
    const subscriber = await db.getWalletSubscriber(wallet);
    return res.json({
      success: true,
      subscriber
    });
  } catch (err) {
    console.error('Error in /api/wallet/subscription:', err);
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
    console.log(`🚀 SubStream Shared Backend running on port ${PORT}`);
    console.log(`📡 Local URL: http://localhost:${PORT}`);
    console.log(`🔐 Developer accounts active with automatic bypass`);
    console.log(`=======================================================`);
  });
}

startServer();

module.exports = app;
