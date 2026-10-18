const { Pool } = require('pg');
const dotenv = require('dotenv');
const crypto = require('crypto');

dotenv.config();

const DEFAULT_DEVELOPER_EMAILS = [
  'malaniamichael@gmail.com',
  'bnbstakers@protonmail.com',
  'developer@omnitranslate.live',
  'admin@omnitranslate.live',
  'ninotura.kura@gmail.com',
  'ninoturakura@gmail.com'
];

const FREE_TIER_MAX_TRANSLATIONS = 15;
const FREE_TIER_MAX_SECONDS = 300;

class Database {
  constructor() {
    this.pool = null;
    this.isPostgres = false;
    this.memoryUsers = {};
    this.memoryOtp = {};
    this.systemConfig = {
      freeQuotaTranslations: FREE_TIER_MAX_TRANSLATIONS,
      freeQuotaSeconds: FREE_TIER_MAX_SECONDS,
      developerEmails: DEFAULT_DEVELOPER_EMAILS
    };
    this.initPromise = this.init();
  }

  async init() {
    const connectionString = process.env.DATABASE_URL;
    if (connectionString) {
      try {
        const isSsl = !connectionString.includes('localhost') && !connectionString.includes('127.0.0.1');
        this.pool = new Pool({
          connectionString,
          ssl: isSsl ? { rejectUnauthorized: false } : false,
          max: 10,
          idleTimeoutMillis: 30000,
          connectionTimeoutMillis: 5000
        });

        // Test connection and initialize schema
        const client = await this.pool.connect();
        try {
          await client.query(`
            CREATE TABLE IF NOT EXISTS users (
              email VARCHAR(255) PRIMARY KEY,
              display_name VARCHAR(255),
              photo_url TEXT,
              platform VARCHAR(50) DEFAULT 'desktop',
              role VARCHAR(50) DEFAULT 'user',
              tier VARCHAR(50) DEFAULT 'free',
              is_paid BOOLEAN DEFAULT FALSE,
              is_developer BOOLEAN DEFAULT FALSE,
              developer_bypass BOOLEAN DEFAULT FALSE,
              translations_count INT DEFAULT 0,
              seconds_total INT DEFAULT 0,
              last_used_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
              created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
              updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
            );

            CREATE TABLE IF NOT EXISTS usage_logs (
              id SERIAL PRIMARY KEY,
              user_email VARCHAR(255) REFERENCES users(email) ON DELETE CASCADE,
              seconds INT DEFAULT 3,
              chars INT DEFAULT 0,
              platform VARCHAR(50) DEFAULT 'desktop',
              created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
            );

            CREATE TABLE IF NOT EXISTS email_verification_codes (
              email VARCHAR(255) PRIMARY KEY,
              code VARCHAR(10) NOT NULL,
              display_name VARCHAR(255),
              expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
              created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
            );

            ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;
            ALTER TABLE email_verification_codes ADD COLUMN IF NOT EXISTS password_hash TEXT;
            ALTER TABLE email_verification_codes ADD COLUMN IF NOT EXISTS action_type VARCHAR(50) DEFAULT 'verify';
          `);

          // Seed default developer account if not exists
          for (const devEmail of DEFAULT_DEVELOPER_EMAILS) {
            await client.query(`
              INSERT INTO users (email, display_name, role, tier, is_paid, is_developer, developer_bypass)
              VALUES ($1, $2, 'developer', 'developer', TRUE, TRUE, TRUE)
              ON CONFLICT (email) DO UPDATE
              SET is_developer = TRUE, role = 'developer', is_paid = TRUE, developer_bypass = TRUE;
            `, [devEmail, devEmail.split('@')[0]]);
          }

          this.isPostgres = true;
          console.log('✅ [DB] Connected to Render PostgreSQL and initialized schema successfully.');
        } finally {
          client.release();
        }
      } catch (err) {
        console.error('⚠️ [DB] PostgreSQL connection failed, falling back to in-memory store:', err.message);
        this.isPostgres = false;
      }
    } else {
      console.log('ℹ️ [DB] No DATABASE_URL set; using in-memory store.');
    }
  }

  normalizeEmail(email) {
    if (!email) return '';
    const clean = email.toLowerCase().trim();
    const parts = clean.split('@');
    if (parts.length === 2 && parts[1] === 'gmail.com') {
      return `${parts[0].replace(/\./g, '')}@gmail.com`;
    }
    return clean;
  }

  isDeveloperEmail(email) {
    if (!email) return false;
    const clean = this.normalizeEmail(email);
    const envDevs = (process.env.DEVELOPER_EMAILS || '')
      .split(',')
      .map(e => this.normalizeEmail(e.trim()))
      .filter(Boolean);
    const allDevs = [...this.systemConfig.developerEmails.map(e => this.normalizeEmail(e)), ...envDevs];
    return allDevs.some(dev => clean === dev || clean.endsWith('@omnitranslate.live'));
  }

  formatUser(row) {
    if (!row) return null;
    return {
      email: row.email,
      displayName: row.display_name,
      photoUrl: row.photo_url || '',
      platform: row.platform || 'desktop',
      role: row.role || 'user',
      tier: row.tier || 'free',
      isPaid: Boolean(row.is_paid),
      isDeveloper: Boolean(row.is_developer),
      developerBypass: Boolean(row.developer_bypass),
      hasPassword: Boolean(row.password_hash),
      usage: {
        translationsCount: Number(row.translations_count) || 0,
        secondsTotal: Number(row.seconds_total) || 0,
        lastUsedAt: row.last_used_at
      },
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  async getUser(email) {
    if (this.initPromise) await this.initPromise;
    if (!email) return null;
    const clean = email.toLowerCase().trim();

    if (this.isPostgres && this.pool) {
      try {
        const res = await this.pool.query('SELECT * FROM users WHERE LOWER(email) = LOWER($1)', [clean]);
        return this.formatUser(res.rows[0]);
      } catch (e) {
        console.error('[DB] getUser error:', e.message);
      }
    }
    return this.memoryUsers[clean] || null;
  }

  async findOrCreateUser({ email, displayName, photoUrl, platform = 'desktop' }) {
    if (this.initPromise) await this.initPromise;
    if (!email) return null;
    const clean = email.toLowerCase().trim();
    const isDev = this.isDeveloperEmail(clean);
    const cleanName = displayName || clean.split('@')[0];

    if (this.isPostgres && this.pool) {
      try {
        const role = isDev ? 'developer' : 'user';
        const tier = isDev ? 'developer' : 'free';
        const isPaid = isDev;
        const devBypass = isDev;

        const res = await this.pool.query(`
          INSERT INTO users (email, display_name, photo_url, platform, role, tier, is_paid, is_developer, developer_bypass)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          ON CONFLICT (email) DO UPDATE
          SET display_name = COALESCE(NULLIF($2, ''), users.display_name),
              photo_url = COALESCE(NULLIF($3, ''), users.photo_url),
              is_developer = CASE WHEN $8 = TRUE THEN TRUE ELSE users.is_developer END,
              role = CASE WHEN $8 = TRUE THEN 'developer' ELSE users.role END,
              is_paid = CASE WHEN $8 = TRUE THEN TRUE ELSE users.is_paid END,
              updated_at = NOW()
          RETURNING *;
        `, [clean, cleanName, photoUrl || '', platform, role, tier, isPaid, isDev, devBypass]);

        return this.formatUser(res.rows[0]);
      } catch (e) {
        console.error('[DB] findOrCreateUser Postgres error:', e.message);
      }
    }

    // Memory fallback
    let user = this.memoryUsers[clean];
    if (!user) {
      user = {
        email: clean,
        displayName: cleanName,
        photoUrl: photoUrl || '',
        platform,
        role: isDev ? 'developer' : 'user',
        tier: isDev ? 'developer' : 'free',
        isPaid: isDev,
        isDeveloper: isDev,
        developerBypass: isDev,
        usage: { translationsCount: 0, secondsTotal: 0, lastUsedAt: new Date().toISOString() },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      this.memoryUsers[clean] = user;
    }
    return user;
  }

  hashPassword(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
    return `${salt}:${hash}`;
  }

  verifyPassword(password, stored) {
    if (!stored || typeof stored !== 'string' || !stored.includes(':')) return false;
    const [salt, originalHash] = stored.split(':');
    const hash = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
    return hash === originalHash;
  }

  async registerUser({ email, password, displayName, platform = 'desktop' }) {
    if (this.initPromise) await this.initPromise;
    if (!email || !password) {
      throw new Error('Email and password are required');
    }
    const clean = email.toLowerCase().trim();
    if (password.length < 6) {
      throw new Error('Password must be at least 6 characters');
    }

    const isDev = this.isDeveloperEmail(clean);
    const cleanName = displayName || clean.split('@')[0];
    const passwordHash = this.hashPassword(password);

    if (this.isPostgres && this.pool) {
      const existing = await this.pool.query('SELECT * FROM users WHERE LOWER(email) = LOWER($1)', [clean]);
      if (existing.rows.length > 0) {
        if (existing.rows[0].password_hash) {
          throw new Error('An account with this email already exists. Please sign in instead.');
        } else {
          const res = await this.pool.query(`
            UPDATE users
            SET password_hash = $2,
                display_name = COALESCE(NULLIF($3, ''), display_name),
                updated_at = NOW()
            WHERE LOWER(email) = LOWER($1)
            RETURNING *;
          `, [clean, passwordHash, cleanName]);
          return this.formatUser(res.rows[0]);
        }
      }

      const role = isDev ? 'developer' : 'user';
      const tier = isDev ? 'developer' : 'free';
      const isPaid = isDev;
      const devBypass = isDev;

      const res = await this.pool.query(`
        INSERT INTO users (email, display_name, password_hash, platform, role, tier, is_paid, is_developer, developer_bypass)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING *;
      `, [clean, cleanName, passwordHash, platform, role, tier, isPaid, isDev, devBypass]);

      return this.formatUser(res.rows[0]);
    }

    if (this.memoryUsers[clean] && this.memoryUsers[clean].passwordHash) {
      throw new Error('An account with this email already exists. Please sign in instead.');
    }
    const user = {
      email: clean,
      displayName: cleanName,
      passwordHash,
      platform,
      role: isDev ? 'developer' : 'user',
      tier: isDev ? 'developer' : 'free',
      isPaid: isDev,
      isDeveloper: isDev,
      developerBypass: isDev,
      usage: { translationsCount: 0, secondsTotal: 0, lastUsedAt: new Date().toISOString() },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    this.memoryUsers[clean] = user;
    return user;
  }

  async loginUser({ email, password }) {
    if (this.initPromise) await this.initPromise;
    if (!email || !password) {
      throw new Error('Email and password are required');
    }
    const clean = email.toLowerCase().trim();
    const isDev = this.isDeveloperEmail(clean);

    if (this.isPostgres && this.pool) {
      const res = await this.pool.query('SELECT * FROM users WHERE LOWER(email) = LOWER($1)', [clean]);
      let row = res.rows[0];

      if (!row) {
        if (isDev) {
          return await this.registerUser({ email: clean, password, displayName: clean.split('@')[0] });
        }
        throw new Error('Account not found with this email. Please register first.');
      }

      if (!row.password_hash) {
        const passwordHash = this.hashPassword(password);
        await this.pool.query('UPDATE users SET password_hash = $2, updated_at = NOW() WHERE LOWER(email) = LOWER($1)', [clean, passwordHash]);
        row.password_hash = passwordHash;
      } else {
        const valid = this.verifyPassword(password, row.password_hash);
        if (!valid) {
          throw new Error('Incorrect password. Please try again.');
        }
      }

      return this.formatUser(row);
    }

    let user = this.memoryUsers[clean];
    if (!user) {
      if (isDev) {
        return await this.registerUser({ email: clean, password });
      }
      throw new Error('Account not found with this email. Please register first.');
    }
    if (user.passwordHash && !this.verifyPassword(password, user.passwordHash)) {
      throw new Error('Incorrect password. Please try again.');
    }
    return user;
  }

  async checkUsagePermission(email) {
    const clean = (email || '').toLowerCase().trim();
    const user = await this.getUser(clean);
    const maxAllowed = this.systemConfig.freeQuotaTranslations;

    if (!user) {
      return {
        allowed: true,
        canTranslate: true,
        isDeveloper: false,
        isPaid: false,
        developerBypass: false,
        tier: 'free',
        usedCount: 0,
        maxQuota: maxAllowed,
        remaining: maxAllowed,
        reason: 'NEW_USER'
      };
    }

    // Developer privilege: if developer and bypass is ON, metrics are completely disabled
    if (user.isDeveloper && user.developerBypass) {
      return {
        allowed: true,
        canTranslate: true,
        isDeveloper: true,
        isPaid: true,
        developerBypass: true,
        tier: 'developer',
        usedCount: user.usage.translationsCount,
        maxQuota: 999999,
        remaining: 'unlimited',
        reason: 'DEVELOPER_OVERRIDE'
      };
    }

    // Paid subscriber (Pro or Enterprise)
    if (user.isPaid || user.tier === 'pro' || user.tier === 'enterprise') {
      return {
        allowed: true,
        canTranslate: true,
        isDeveloper: user.isDeveloper || false,
        isPaid: true,
        developerBypass: false,
        tier: user.tier,
        usedCount: user.usage.translationsCount,
        maxQuota: 999999,
        remaining: 'unlimited',
        reason: 'PAID_ACTIVE'
      };
    }

    // Free tier evaluation
    const used = user.usage.translationsCount;
    const remaining = Math.max(0, maxAllowed - used);
    const allowed = used < maxAllowed;

    return {
      allowed: allowed,
      canTranslate: allowed,
      isDeveloper: user.isDeveloper || false,
      isPaid: false,
      developerBypass: false,
      tier: 'free',
      usedCount: used,
      maxQuota: maxAllowed,
      remaining: remaining,
      reason: allowed ? 'QUOTA_OK' : 'QUOTA_EXCEEDED'
    };
  }

  async recordUsage({ email, seconds = 3, chars = 0, platform = 'desktop' }) {
    const clean = (email || '').toLowerCase().trim();
    let user = await this.getUser(clean);

    if (!user) {
      user = await this.findOrCreateUser({ email: clean, platform });
    }

    const permission = await this.checkUsagePermission(clean);
    if (!permission.allowed) {
      return {
        success: false,
        allowed: false,
        reason: 'QUOTA_EXCEEDED',
        message: `Free quota limit reached (${permission.usedCount}/${permission.maxQuota}). Upgrade to Pro to continue.`,
        upgradeUrl: 'https://michael-malania.github.io/omnitranslate-website/#pricing',
        stats: permission
      };
    }

    const secNum = Number(seconds) || 3;
    const charNum = Number(chars) || 0;

    if (this.isPostgres && this.pool) {
      try {
        await this.pool.query(`
          UPDATE users
          SET translations_count = translations_count + 1,
              seconds_total = seconds_total + $2,
              last_used_at = NOW(),
              updated_at = NOW()
          WHERE LOWER(email) = LOWER($1);
        `, [clean, secNum]);

        await this.pool.query(`
          INSERT INTO usage_logs (user_email, seconds, chars, platform)
          VALUES ($1, $2, $3, $4);
        `, [clean, secNum, charNum, platform]);

        const updatedPermission = await this.checkUsagePermission(clean);
        return {
          success: true,
          allowed: true,
          reason: updatedPermission.reason,
          stats: updatedPermission
        };
      } catch (e) {
        console.error('[DB] recordUsage Postgres error:', e.message);
      }
    }

    // Memory fallback
    user.usage.translationsCount += 1;
    user.usage.secondsTotal += secNum;
    user.usage.lastUsedAt = new Date().toISOString();
    user.updatedAt = new Date().toISOString();

    const updated = await this.checkUsagePermission(clean);
    return {
      success: true,
      allowed: true,
      reason: updated.reason,
      stats: updated
    };
  }

  async toggleDeveloperBypass(email, enabled) {
    const clean = (email || '').toLowerCase().trim();
    const user = await this.getUser(clean);
    if (!user || !user.isDeveloper) {
      throw new Error('Only developer accounts can toggle developer bypass mode');
    }

    if (this.isPostgres && this.pool) {
      await this.pool.query(`
        UPDATE users
        SET developer_bypass = $2, updated_at = NOW()
        WHERE LOWER(email) = LOWER($1);
      `, [clean, Boolean(enabled)]);
    } else {
      user.developerBypass = Boolean(enabled);
    }

    return await this.checkUsagePermission(clean);
  }

  async setTier(email, tier) {
    const clean = (email || '').toLowerCase().trim();
    const isPaid = tier === 'pro' || tier === 'enterprise' || tier === 'developer';

    if (this.isPostgres && this.pool) {
      const res = await this.pool.query(`
        UPDATE users
        SET tier = $2, is_paid = $3, updated_at = NOW()
        WHERE LOWER(email) = LOWER($1)
        RETURNING *;
      `, [clean, tier, isPaid]);
      return this.formatUser(res.rows[0]);
    }

    let user = this.memoryUsers[clean];
    if (user) {
      user.tier = tier;
      user.isPaid = isPaid;
    }
    return user;
  }

  async getPlatformMetrics() {
    if (this.initPromise) await this.initPromise;
    if (this.isPostgres && this.pool) {
      try {
        const res = await this.pool.query(`
          SELECT 
            COUNT(*)::INT as total_users,
            COUNT(*) FILTER (WHERE is_developer)::INT as developers,
            COUNT(*) FILTER (WHERE is_paid)::INT as paid_users,
            COALESCE(SUM(translations_count), 0)::INT as total_translations,
            COALESCE(SUM(seconds_total), 0)::INT as total_seconds
          FROM users;
        `);
        const row = res.rows[0] || {};
        const totalUsers = row.total_users || 0;
        const paidUsers = row.paid_users || 0;
        return {
          totalUsers,
          developers: row.developers || 0,
          paidUsers,
          freeUsers: totalUsers - paidUsers,
          totalTranslations: row.total_translations || 0,
          totalMinutes: Math.round((row.total_seconds || 0) / 60)
        };
      } catch (e) {
        console.error('[DB] getPlatformMetrics error:', e.message);
      }
    }

    const users = Object.values(this.memoryUsers);
    const totalUsers = users.length;
    const paidUsers = users.filter(u => u.isPaid).length;
    const totalTranslations = users.reduce((sum, u) => sum + (u.usage.translationsCount || 0), 0);
    const totalSeconds = users.reduce((sum, u) => sum + (u.usage.secondsTotal || 0), 0);

    return {
      totalUsers,
      developers: users.filter(u => u.isDeveloper).length,
      paidUsers,
      freeUsers: totalUsers - paidUsers,
      totalTranslations,
      totalMinutes: Math.round(totalSeconds / 60)
    };
  }

  async saveVerificationCode(email, code, displayName = '') {
    if (this.initPromise) await this.initPromise;
    const clean = email.toLowerCase().trim();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    if (this.isPostgres && this.pool) {
      try {
        await this.pool.query(`
          INSERT INTO email_verification_codes (email, code, display_name, expires_at, created_at)
          VALUES ($1, $2, $3, $4, NOW())
          ON CONFLICT (email) DO UPDATE
          SET code = $2,
              display_name = COALESCE(NULLIF($3, ''), email_verification_codes.display_name),
              expires_at = $4,
              created_at = NOW();
        `, [clean, code, displayName, expiresAt]);
        return true;
      } catch (err) {
        console.error('[DB] saveVerificationCode Postgres error:', err.message);
      }
    }

    this.memoryOtp[clean] = {
      code,
      displayName,
      expiresAt: expiresAt.getTime()
    };
    return true;
  }

  async verifyCode({ email, code, platform = 'desktop' }) {
    if (this.initPromise) await this.initPromise;
    if (!email || !code) {
      throw new Error('Email and verification code are required');
    }
    const clean = email.toLowerCase().trim();
    const cleanCode = code.trim();

    let matched = false;
    let storedDisplayName = '';

    if (this.isPostgres && this.pool) {
      try {
        const res = await this.pool.query(
          'SELECT * FROM email_verification_codes WHERE LOWER(email) = LOWER($1)',
          [clean]
        );
        if (res.rows.length > 0) {
          const row = res.rows[0];
          const isExpired = new Date(row.expires_at).getTime() < Date.now();
          if (isExpired) {
            await this.pool.query('DELETE FROM email_verification_codes WHERE LOWER(email) = LOWER($1)', [clean]);
            throw new Error('Verification code has expired. Please request a new code.');
          }
          if (row.code === cleanCode) {
            matched = true;
            storedDisplayName = row.display_name;
            await this.pool.query('DELETE FROM email_verification_codes WHERE LOWER(email) = LOWER($1)', [clean]);
          }
        }
      } catch (err) {
        if (err.message.includes('expired')) throw err;
        console.error('[DB] verifyCode Postgres error:', err.message);
      }
    }

    if (!matched && this.memoryOtp[clean]) {
      const stored = this.memoryOtp[clean];
      if (stored.expiresAt < Date.now()) {
        delete this.memoryOtp[clean];
        throw new Error('Verification code has expired. Please request a new code.');
      }
      if (stored.code === cleanCode) {
        matched = true;
        storedDisplayName = stored.displayName;
        delete this.memoryOtp[clean];
      }
    }

    if (!matched) {
      throw new Error('Invalid verification code. Please check your email and try again.');
    }

    // Authenticated successfully! Find or create user
    return await this.findOrCreateUser({
      email: clean,
      displayName: storedDisplayName,
      platform
    });
  }

  async saveRegistrationCode({ email, code, displayName = '', passwordHash = '' }) {
    if (this.initPromise) await this.initPromise;
    const clean = email.toLowerCase().trim();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    if (this.isPostgres && this.pool) {
      try {
        await this.pool.query(`
          INSERT INTO email_verification_codes (email, code, display_name, password_hash, action_type, expires_at, created_at)
          VALUES ($1, $2, $3, $4, 'register', $5, NOW())
          ON CONFLICT (email) DO UPDATE
          SET code = $2,
              display_name = COALESCE(NULLIF($3, ''), email_verification_codes.display_name),
              password_hash = $4,
              action_type = 'register',
              expires_at = $5,
              created_at = NOW();
        `, [clean, code, displayName, passwordHash, expiresAt]);
        return true;
      } catch (err) {
        console.error('[DB] saveRegistrationCode Postgres error:', err.message);
      }
    }

    this.memoryOtp[clean] = {
      code,
      displayName,
      passwordHash,
      actionType: 'register',
      expiresAt: expiresAt.getTime()
    };
    return true;
  }

  async verifyRegistration({ email, code, platform = 'desktop' }) {
    if (this.initPromise) await this.initPromise;
    if (!email || !code) {
      throw new Error('Email and verification code are required');
    }
    const clean = email.toLowerCase().trim();
    const cleanCode = code.trim();

    let matched = false;
    let storedDisplayName = '';
    let storedPasswordHash = '';

    if (this.isPostgres && this.pool) {
      try {
        const res = await this.pool.query(
          'SELECT * FROM email_verification_codes WHERE LOWER(email) = LOWER($1)',
          [clean]
        );
        if (res.rows.length > 0) {
          const row = res.rows[0];
          const isExpired = new Date(row.expires_at).getTime() < Date.now();
          if (isExpired) {
            await this.pool.query('DELETE FROM email_verification_codes WHERE LOWER(email) = LOWER($1)', [clean]);
            throw new Error('Verification code has expired. Please sign up again to receive a fresh code.');
          }
          if (row.code === cleanCode) {
            matched = true;
            storedDisplayName = row.display_name || clean.split('@')[0];
            storedPasswordHash = row.password_hash || '';
            await this.pool.query('DELETE FROM email_verification_codes WHERE LOWER(email) = LOWER($1)', [clean]);
          }
        }
      } catch (err) {
        if (err.message.includes('expired')) throw err;
        console.error('[DB] verifyRegistration Postgres error:', err.message);
      }
    }

    if (!matched && this.memoryOtp[clean]) {
      const stored = this.memoryOtp[clean];
      if (stored.expiresAt < Date.now()) {
        delete this.memoryOtp[clean];
        throw new Error('Verification code has expired. Please sign up again to receive a fresh code.');
      }
      if (stored.code === cleanCode) {
        matched = true;
        storedDisplayName = stored.displayName || clean.split('@')[0];
        storedPasswordHash = stored.passwordHash || '';
        delete this.memoryOtp[clean];
      }
    }

    if (!matched) {
      throw new Error('Invalid verification code. Please check your email and try again.');
    }

    const isDev = this.isDeveloperEmail(clean);
    const role = isDev ? 'developer' : 'user';
    const tier = isDev ? 'developer' : 'free';
    const isPaid = isDev;
    const devBypass = isDev;

    if (this.isPostgres && this.pool) {
      const res = await this.pool.query(`
        INSERT INTO users (email, display_name, password_hash, platform, role, tier, is_paid, is_developer, developer_bypass)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (email) DO UPDATE
        SET display_name = COALESCE(NULLIF($2, ''), users.display_name),
            password_hash = COALESCE(NULLIF($3, ''), users.password_hash),
            is_developer = CASE WHEN $8 = TRUE THEN TRUE ELSE users.is_developer END,
            role = CASE WHEN $8 = TRUE THEN 'developer' ELSE users.role END,
            is_paid = CASE WHEN $8 = TRUE THEN TRUE ELSE users.is_paid END,
            updated_at = NOW()
        RETURNING *;
      `, [clean, storedDisplayName, storedPasswordHash, platform, role, tier, isPaid, isDev, devBypass]);

      return this.formatUser(res.rows[0]);
    }

    const user = {
      email: clean,
      displayName: storedDisplayName,
      passwordHash: storedPasswordHash,
      platform,
      role,
      tier,
      isPaid,
      isDeveloper: isDev,
      developerBypass: devBypass,
      usage: { translationsCount: 0, secondsTotal: 0, lastUsedAt: new Date().toISOString() },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    this.memoryUsers[clean] = user;
    return user;
  }
}

module.exports = new Database();
