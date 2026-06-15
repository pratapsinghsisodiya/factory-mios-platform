'use strict';
/**
 * Run with: node scripts/setup-users.js
 *
 * Creates / resets the admin user:
 *   admin / 123  → lands on / (main OEE dashboard)
 *
 * Note: superadmin / super@123 is auto-created by server.js on startup.
 */
const bcrypt = require('bcryptjs');
const fs     = require('fs');
const path   = require('path');

const USERS_PATH = path.join(__dirname, '..', 'config', 'users.json');

async function upsertUser(store, { username, password, name, role, default_page }) {
  let user = store.users.find(u => u.username === username);
  const hash = await bcrypt.hash(password, 10);
  if (user) {
    user.password_hash = hash;
    user.name         = name;
    user.role         = role;
    user.default_page = default_page;
    user.active       = true;
    console.log(`✅ Updated  → ${username} / ${password}  (→ ${default_page})`);
  } else {
    store.users.push({
      id:            username,
      username,
      password_hash: hash,
      name,
      role,
      email:         '',
      phone:         '',
      alerts:        'both',
      plant_ids:     [],
      default_page,
      active:        true,
      created_at:    new Date().toISOString(),
    });
    console.log(`✅ Created  → ${username} / ${password}  (→ ${default_page})`);
  }
}

async function run() {
  let store;
  try { store = JSON.parse(fs.readFileSync(USERS_PATH, 'utf8')); }
  catch { store = { users: [] }; }

  console.log('\n─────────────────────────────────────────');
  console.log(' Factory-MIOS — User Setup');
  console.log('─────────────────────────────────────────');

  await upsertUser(store, {
    username:     'admin',
    password:     '123',
    name:         'Demo Factory Administrator',
    role:         'admin',
    default_page: '/',
  });

  fs.writeFileSync(USERS_PATH, JSON.stringify(store, null, 2));

  console.log('\n─────────────────────────────────────────');
  console.log(' Login credentials');
  console.log('─────────────────────────────────────────');
  console.log('   URL      : http://localhost:3000/login');
  console.log('   Username : admin');
  console.log('   Password : 123');
  console.log('   Lands on : / (OEE Dashboard)');
  console.log('\n   Username : superadmin');
  console.log('   Password : super@123');
  console.log('   Lands on : /saas-platform (Platform Admin)');
  console.log('─────────────────────────────────────────\n');
}

run().catch(e => { console.error('❌', e.message); process.exit(1); });
