'use strict';
/**
 * auth.js — JWT + bcrypt authentication helper
 * Users stored in config/users.json
 * Roles: superadmin | admin | plant_admin | manager | operator
 */

const bcrypt = require('bcryptjs');
const jwt    = require('jsonwebtoken');
const fs     = require('fs');
const path   = require('path');

const USERS_PATH = path.join(__dirname, '..', 'config', 'users.json');
const DEFAULT_JWT_SECRET = 'factory-mios-platform-secret-2026-factory-mios';
const JWT_EXPIRE = process.env.JWT_EXPIRE || '24h';
const SALT_ROUNDS = 10;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

function getJwtSecret() {
  const secret = process.env.JWT_SECRET || DEFAULT_JWT_SECRET;
  const isPlaceholder = /^replace_with_/i.test(secret);
  if (IS_PRODUCTION && (!process.env.JWT_SECRET || secret === DEFAULT_JWT_SECRET || isPlaceholder)) {
    throw new Error('JWT_SECRET must be set to a strong random value in production');
  }
  return secret;
}

function allowQueryTokenAuth() {
  return process.env.ALLOW_QUERY_TOKEN_AUTH === 'true';
}

// ── Load / Save users ─────────────────────────────────────────────────────────
function loadUsers() {
  try { return JSON.parse(fs.readFileSync(USERS_PATH, 'utf8')); }
  catch { return { users: [] }; }
}
function saveUsers(store) {
  const dir = path.dirname(USERS_PATH);
  fs.mkdirSync(dir, { recursive: true, mode: 0o777 });
  try {
    fs.writeFileSync(USERS_PATH, JSON.stringify(store, null, 2), { mode: 0o666 });
  } catch (err) {
    if (err.code === 'EACCES') {
      throw new Error('Cannot write users.json — fix /app/config permissions and restart the app container');
    }
    throw err;
  }
}

// ── Hash password ─────────────────────────────────────────────────────────────
async function hashPassword(plain) {
  return bcrypt.hash(plain, SALT_ROUNDS);
}

// ── Verify password ───────────────────────────────────────────────────────────
async function verifyPassword(plain, hashed) {
  return bcrypt.compare(plain, hashed);
}

// ── Generate JWT ──────────────────────────────────────────────────────────────
function generateToken(user) {
  return jwt.sign(
    {
      id:          user.id,
      username:    user.username,
      role:        user.role,
      plant_ids:   user.plant_ids   || [],
      tenant_slug: user.tenant_slug || null,
      tenant_id:   user.tenant_id   || null,
    },
    getJwtSecret(),
    { expiresIn: JWT_EXPIRE }
  );
}

// ── Verify JWT ────────────────────────────────────────────────────────────────
function verifyToken(token) {
  try { return jwt.verify(token, getJwtSecret()); }
  catch { return null; }
}

// ── Auth middleware ───────────────────────────────────────────────────────────
function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '') || (allowQueryTokenAuth() ? req.query._token : null);
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  const decoded = verifyToken(token);
  if (!decoded) return res.status(401).json({ error: 'Invalid or expired token' });
  req.user = decoded;
  next();
}

// ── Find user by username ─────────────────────────────────────────────────────
function findUser(username) {
  const store = loadUsers();
  return store.users.find(u => u.username === username);
}

// ── Create user ───────────────────────────────────────────────────────────────
async function createUser({ username, password, name, role, email, phone, alerts, plant_ids, tenant_id, tenant_slug }) {
  const store = loadUsers();
  if (store.users.find(u => u.username === username)) {
    throw new Error(`User "${username}" already exists`);
  }
  const hashed = await hashPassword(password);
  const user = {
    id:            Date.now().toString(),
    username:      username.toLowerCase().trim(),
    password_hash: hashed,
    name:          name || username,
    role:          role || 'operator',
    email:         email || '',
    phone:         phone || '',
    alerts:        alerts || 'both',
    plant_ids:     plant_ids  || [],        // [] means sees all
    tenant_id:     tenant_id  || null,
    tenant_slug:   tenant_slug|| null,
    active:        true,
    created_at:    new Date().toISOString(),
  };
  store.users.push(user);
  saveUsers(store);
  return user;
}

// ── Update user password ──────────────────────────────────────────────────────
async function updatePassword(username, newPassword) {
  const store = loadUsers();
  const user  = store.users.find(u => u.username === username);
  if (!user) throw new Error('User not found');
  user.password_hash = await hashPassword(newPassword);
  saveUsers(store);
}

// ── Ensure default users exist (called at server start) ───────────────────────
async function ensureAdminExists() {
  const store = loadUsers();
  let changed = false;

  if (IS_PRODUCTION && process.env.ENABLE_DEFAULT_USERS !== 'true') {
    console.log('[Auth] Default user bootstrap disabled in production');
    return;
  }

  // ── 1. Admin user — Demo Factory tenant ─────────────────────────────────────────
  const existingAdmin = store.users.find(u => u.username === 'admin');
  if (!existingAdmin) {
    const hashed = await hashPassword('123');
    store.users.push({
      id:            'admin',
      username:      'admin',
      password_hash: hashed,
      name:          'Demo Factory Administrator',
      role:          'admin',
      email:         '',
      phone:         '',
      alerts:        'both',
      plant_ids:     [],              // admin sees all plants
      tenant_id:     1,               // Factory-MIOS Demo tenant (seeded in DB)
      tenant_slug:   'factory-mios-demo',
      active:        true,
      created_at:    new Date().toISOString(),
    });
    console.log('[Auth] ✅ Admin user created — username: admin / password: 123 / tenant: factory-mios-demo');
    changed = true;
  } else {
    // Back-fill tenant info if missing
    if (!existingAdmin.tenant_slug) {
      existingAdmin.tenant_slug = 'factory-mios-demo';
      existingAdmin.tenant_id   = 1;
      changed = true;
    }
    console.log('[Auth] ✅ Admin user exists');
  }

  // ── 2. Superadmin — platform-wide ─────────────────────────────────────────
  const existingSA = store.users.find(u => u.username === 'superadmin');
  if (!existingSA) {
    const hashed = await hashPassword('super@123');
    store.users.push({
      id:            'superadmin',
      username:      'superadmin',
      password_hash: hashed,
      name:          'Super Administrator',
      role:          'superadmin',
      email:         'superadmin@factory-mios.local',
      phone:         '',
      alerts:        'both',
      plant_ids:     [],              // sees everything
      tenant_id:     null,            // platform-wide, not tied to a tenant
      tenant_slug:   null,
      default_page:  '/saas-platform', // always land on platform page
      active:        true,
      created_at:    new Date().toISOString(),
    });
    console.log('[Auth] ✅ Superadmin created — username: superadmin / password: super@123');
    changed = true;
  } else {
    // Back-fill default_page if missing
    if (!existingSA.default_page) {
      existingSA.default_page = '/saas-platform';
      changed = true;
    }
    console.log('[Auth] ✅ Superadmin exists');
  }

  if (changed) saveUsers(store);
}

module.exports = {
  loadUsers, saveUsers, hashPassword, verifyPassword,
  generateToken, verifyToken, authMiddleware,
  findUser, createUser, updatePassword, ensureAdminExists,
};
