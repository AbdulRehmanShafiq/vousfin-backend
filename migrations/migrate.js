// migrations/migrate.js
const { MongoClient } = require('mongodb');
const path = require('path');
const fs = require('fs').promises;
const config = require('../config');

const MIGRATIONS_COLLECTION = 'migrations';
const MIGRATIONS_DIR = __dirname;

async function getAppliedMigrations(db) {
  const collection = db.collection(MIGRATIONS_COLLECTION);
  const docs = await collection.find().sort({ appliedAt: 1 }).toArray();
  return docs.map(doc => doc.name);
}

async function recordMigration(db, name, direction) {
  const collection = db.collection(MIGRATIONS_COLLECTION);
  await collection.insertOne({
    name,
    direction,
    appliedAt: new Date(),
  });
}

async function removeMigration(db, name) {
  const collection = db.collection(MIGRATIONS_COLLECTION);
  await collection.deleteOne({ name });
}

async function loadMigrations() {
  const files = await fs.readdir(MIGRATIONS_DIR);
  const migrationFiles = files
    .filter(f => f.endsWith('.js') && f !== 'template.js' && f !== 'migrate.js')
    .sort(); // lexical order = chronological if you name with date prefix
  const migrations = [];
  for (const file of migrationFiles) {
    const filePath = path.join(MIGRATIONS_DIR, file);
    const migration = require(filePath);
    migrations.push({ name: file.replace('.js', ''), up: migration.up, down: migration.down });
  }
  return migrations;
}

async function runUp(db, client) {
  const applied = await getAppliedMigrations(db);
  const all = await loadMigrations();
  const pending = all.filter(m => !applied.includes(m.name));
  if (pending.length === 0) {
    console.log('No pending migrations.');
    return;
  }
  for (const mig of pending) {
    console.log(`Applying: ${mig.name}`);
    await mig.up(db, client);
    await recordMigration(db, mig.name, 'up');
    console.log(`✅ Applied ${mig.name}`);
  }
}

async function runDown(db, client, steps = 1) {
  const applied = await getAppliedMigrations(db);
  if (applied.length === 0) {
    console.log('No migrations to roll back.');
    return;
  }
  const all = await loadMigrations();
  const toRollback = applied.slice(-steps).reverse();
  for (const name of toRollback) {
    const migration = all.find(m => m.name === name);
    if (!migration) {
      console.error(`Migration ${name} not found in files`);
      continue;
    }
    console.log(`Rolling back: ${name}`);
    await migration.down(db, client);
    await removeMigration(db, name);
    console.log(`✅ Rolled back ${name}`);
  }
}

async function main() {
  const client = new MongoClient(config.MONGO_URI);
  try {
    await client.connect();
    console.log('Connected to MongoDB');
    const db = client.db();

    const command = process.argv[2];
    const steps = parseInt(process.argv[3], 10) || 1;

    if (command === 'up') {
      await runUp(db, client);
    } else if (command === 'down') {
      await runDown(db, client, steps);
    } else {
      console.log(`
Usage: node migrations/migrate.js [up|down] [steps]

  up     - Apply all pending migrations
  down   - Roll back the last [steps] migration(s) (default 1)
      `);
    }
  } catch (err) {
    console.error('Migration error:', err);
  } finally {
    await client.close();
  }
}

main();