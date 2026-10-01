// Runs a throwaway Postgres for local development, so analytics can be tried
// without a hosted database. Data lives in .local-db/ (gitignored).
//   npm run db:local
// then start the app with
//   DATABASE_URL=postgres://postgres:postgres@localhost:5433/meetastu
const path = require('path');
const fs = require('fs');
const EmbeddedPostgres = require('embedded-postgres').default;

const dataDir = path.join(__dirname, '..', '.local-db');
const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'postgres',
  password: 'postgres',
  port: 5433,
  persistent: true,
});

(async () => {
  const fresh = !fs.existsSync(path.join(dataDir, 'PG_VERSION'));
  if (fresh) await pg.initialise();
  await pg.start();
  if (fresh) await pg.createDatabase('meetastu');
  console.log('Local Postgres ready: postgres://postgres:postgres@localhost:5433/meetastu');

  const stop = async () => {
    await pg.stop();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
})();
