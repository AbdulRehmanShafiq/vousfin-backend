// migrate-mongo-config.js
const config = require('./config');

module.exports = {
  mongodb: {
    url: config.MONGO_URI,
    // No legacy options: useNewUrlParser/useUnifiedTopology were removed in
    // mongodb driver v4+ and made every `migrate-mongo` command throw
    // MongoParseError — migrations were silently unrunnable.
    options: {},
  },
  migrationsDir: 'migrations',
  changelogCollectionName: 'migrations',
  migrationFileExtension: '.js',
};