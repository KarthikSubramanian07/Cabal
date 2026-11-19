/** Bring the local D1 database up to the schema in migrations/ before any suite runs. Idempotent. */
import { applyD1Migrations, env } from "cloudflare:test";

const testEnv = env as unknown as { DB: D1Database; TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] };
await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
