'use strict';
/**
 * Run with: node scripts/set-admin-password.js
 * Updates the admin user password to 12345678
 */
const bcrypt = require('bcryptjs');
const fs     = require('fs');
const path   = require('path');

const USERS_PATH = path.join(__dirname, '..', 'config', 'users.json');

async function run() {
  let store;
  try { store = JSON.parse(fs.readFileSync(USERS_PATH, 'utf8')); }
  catch { store = { users: [] }; }

  let admin = store.users.find(u => u.username === 'admin');
  const newHash = await bcrypt.hash('12345678', 10);

  if (admin) {
    admin.password_hash = newHash;
    admin.role = 'admin';
    admin.name = 'System Administrator';
    admin.active = true;
    console.log('✅ Admin password updated to: 12345678');
  } else {
    store.users.push({
      id: 'admin',
      username: 'admin',
      password_hash: newHash,
      name: 'System Administrator',
      role: 'admin',
      email: '',
      phone: '',
      alerts: 'both',
      plant_ids: [],
      active: true,
      created_at: new Date().toISOString(),
    });
    console.log('✅ Admin user created — username: admin / password: 12345678');
  }

  fs.writeFileSync(USERS_PATH, JSON.stringify(store, null, 2));
  console.log('✅ Saved to', USERS_PATH);
  console.log('\n  Login at: http://localhost:3000/login');
  console.log('  Username: admin');
  console.log('  Password: 12345678\n');
}

run().catch(e => { console.error('❌', e.message); process.exit(1); });
