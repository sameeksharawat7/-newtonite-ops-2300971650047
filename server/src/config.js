export const config = {
  databaseUrl: process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/newtonite',
  jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-me',
  port: Number(process.env.PORT || 3000),
  // Base for exponential job retry backoff (seconds). Tests set it to 0.
  jobBackoffBase: Number(process.env.JOB_BACKOFF_BASE_SECONDS ?? 5),
  runWorkerInProcess: process.env.RUN_WORKER === 'true',
};
