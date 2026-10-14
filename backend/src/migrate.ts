import { Pool } from 'pg';
import { migrate } from './db';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
migrate(pool)
  .then(() => pool.end())
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
