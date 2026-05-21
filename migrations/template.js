// migrations/template.js
/**
 * Migration template.
 * Copy this file to create a new migration with a descriptive name.
 * 
 * @param {import('mongodb').Db} db - MongoDB database instance
 * @param {import('mongodb').MongoClient} client - MongoDB client
 */
module.exports = {
  // Apply the migration (roll up)
  async up(db, client) {
    // Example: add a new field with default value
    // await db.collection('users').updateMany({}, { $set: { newField: 'default' } });
    console.log('[up] Running migration...');
  },

  // Revert the migration (roll down)
  async down(db, client) {
    // Example: remove the added field
    // await db.collection('users').updateMany({}, { $unset: { newField: '' } });
    console.log('[down] Reverting migration...');
  }
};