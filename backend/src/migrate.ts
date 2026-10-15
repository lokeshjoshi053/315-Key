import { Pool } from 'pg';
import { migrate, poolConfig } from './db';

const pool = new Pool(poolConfig(process.env.DATABASE_URL!, 1));
migrate(pool)
  .then(() => pool.end())
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
