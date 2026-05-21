// migrate-mongo-config.js
const config = require('./config');

module.exports = {
  mongodb: {
    url: config.MONGO_URI,
    options: {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    },
  },
  migrationsDir: 'migrations',
  changelogCollectionName: 'migrations',
  migrationFileExtension: '.js',
};