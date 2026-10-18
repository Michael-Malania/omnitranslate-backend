const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'omni_store.json');

// Pre-configured developer emails that automatically receive developer privileges
const DEFAULT_DEVELOPER_EMAILS = [
  'malaniamichael@gmail.com',
  'bnbstakers@protonmail.com',
  'developer@omnitranslate.live',
  'admin@omnitranslate.live'
];

const FREE_TIER_MAX_TRANSLATIONS = 15;
const FREE_TIER_MAX_SECONDS = 300; // 5 minutes

class Database {
  constructor() {
    this.memory = {
      users: {},
      transactions: [],
      systemConfig: {
        freeQuotaTranslations: FREE_TIER_MAX_TRANSLATIONS,
        freeQuotaSeconds: FREE_TIER_MAX_SECONDS,
        developerEmails: DEFAULT_DEVELOPER_EMAILS
      }
    };
    this.init();
  }

  init() {
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
      if (fs.existsSync(DB_FILE)) {
        const raw = fs.readFileSync(DB_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        this.memory = { ...this.memory, ...parsed };
      } else {
        this.persist();
      }
    } catch (e) {
      console.warn('[DB] Using memory storage, file init warning:', e.message);
    }
  }

  persist() {
    try {
      fs.writeFileSync(DB_FILE, JSON.stringify(this.memory, null, 2), 'utf8');
    } catch (e) {
      console.error('[DB] Failed to persist data to disk:', e.message);
    }
  }

  isDeveloperEmail(email) {
    if (!email) return false;
    const clean = email.toLowerCase().trim();
    const envDevs = (process.env.DEVELOPER_EMAILS || '')
      .split(',')
      .map(e => e.trim().toLowerCase())
      .filter(Boolean);
    const allDevs = [...this.memory.systemConfig.developerEmails, ...envDevs];
    return allDevs.some(dev => clean === dev || clean.endsWith('@omnitranslate.live'));
  }

  getUser(email) {
    if (!email) return null;
    const clean = email.toLowerCase().trim();
    return this.memory.users[clean] || null;
  }

  findOrCreateUser({ email, displayName, photoUrl, platform = 'desktop' }) {
    if (!email) return null;
    const clean = email.toLowerCase().trim();
    let user = this.memory.users[clean];
    const isDev = this.isDeveloperEmail(clean);

    if (!user) {
      user = {
        email: clean,
        displayName: displayName || clean.split('@')[0],
        photoUrl: photoUrl || '',
        platform: platform,
        role: isDev ? 'developer' : 'user',
        tier: isDev ? 'developer' : 'free',
        isPaid: isDev,
        isDeveloper: isDev,
        developerBypass: isDev, // Active bypass for developer
        usage: {
          translationsCount: 0,
          secondsTotal: 0,
          lastUsedAt: new Date().toISOString()
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      this.memory.users[clean] = user;
      this.persist();
    } else {
      // Sync developer privilege in case developer list updated
      if (isDev && !user.isDeveloper) {
        user.isDeveloper = true;
        user.role = 'developer';
        user.tier = 'developer';
        user.isPaid = true;
        user.developerBypass = true;
      }
      if (displayName && displayName !== user.displayName) user.displayName = displayName;
      if (photoUrl && photoUrl !== user.photoUrl) user.photoUrl = photoUrl;
      user.updatedAt = new Date().toISOString();
      this.persist();
    }

    return user;
  }

  checkUsagePermission(email) {
    const clean = (email || '').toLowerCase().trim();
    const user = this.getUser(clean);

    // If no user or anonymous, allow up to free limit via anonymous device record
    const maxAllowed = this.memory.systemConfig.freeQuotaTranslations;

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

  recordUsage({ email, seconds = 3, chars = 0, platform = 'desktop' }) {
    const clean = (email || '').toLowerCase().trim();
    let user = this.getUser(clean);

    if (!user) {
      user = this.findOrCreateUser({ email: clean, platform });
    }

    const permission = this.checkUsagePermission(clean);
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

    // Increment usage
    user.usage.translationsCount += 1;
    user.usage.secondsTotal += Number(seconds) || 3;
    user.usage.lastUsedAt = new Date().toISOString();
    user.updatedAt = new Date().toISOString();

    this.persist();

    const updatedPermission = this.checkUsagePermission(clean);
    return {
      success: true,
      allowed: true,
      reason: updatedPermission.reason,
      stats: updatedPermission
    };
  }

  toggleDeveloperBypass(email, enabled) {
    const clean = (email || '').toLowerCase().trim();
    const user = this.getUser(clean);
    if (!user || !user.isDeveloper) {
      throw new Error('Only developer accounts can toggle developer bypass mode');
    }
    user.developerBypass = Boolean(enabled);
    user.updatedAt = new Date().toISOString();
    this.persist();
    return this.checkUsagePermission(clean);
  }

  setTier(email, tier) {
    const clean = (email || '').toLowerCase().trim();
    let user = this.getUser(clean);
    if (!user) {
      user = this.findOrCreateUser({ email: clean });
    }
    user.tier = tier;
    user.isPaid = tier === 'pro' || tier === 'enterprise' || tier === 'developer';
    user.updatedAt = new Date().toISOString();
    this.persist();
    return user;
  }

  getPlatformMetrics() {
    const users = Object.values(this.memory.users);
    const totalUsers = users.length;
    const developers = users.filter(u => u.isDeveloper).length;
    const paidUsers = users.filter(u => u.isPaid).length;
    const totalTranslations = users.reduce((sum, u) => sum + (u.usage.translationsCount || 0), 0);
    const totalSeconds = users.reduce((sum, u) => sum + (u.usage.secondsTotal || 0), 0);

    return {
      totalUsers,
      developers,
      paidUsers,
      freeUsers: totalUsers - paidUsers,
      totalTranslations,
      totalMinutes: Math.round(totalSeconds / 60)
    };
  }
}

module.exports = new Database();
