const req = (k: string): string => {
  const v = process.env[k];
  if (!v) throw new Error(`Missing required env ${k}`);
  return v;
};
const opt = (k: string, d = ''): string => process.env[k] ?? d;

export function loadConfig() {
  const c = {
    env: opt('APP_ENV', 'dev'),
    port: Number(opt('PORT', '3000')),
    databaseUrl: req('DATABASE_URL'),
    dbPoolSize: Number(opt('DB_POOL_SIZE', '10')),
    jwtSecret: req('JWT_SECRET'),
    accessTtlSec: 15 * 60,
    refreshTtlDays: 30,
    cryptoKey: req('CRYPTO_KEY'),
    bootstrapAdminMobile: opt('BOOTSTRAP_ADMIN_MOBILE'),
    referralLinkBase: opt('REFERRAL_LINK_BASE', 'https://315plots.app/r/'),
    corsOrigins: opt('CORS_ORIGINS').split(',').filter(Boolean),
    swagger: opt('SWAGGER_ENABLED', 'true') === 'true',
    otpProvider: opt('OTP_PROVIDER', 'log') as 'log' | 'msg91',
    msg91: { authKey: opt('MSG91_AUTH_KEY'), templateId: opt('MSG91_TEMPLATE_ID') },
    googleClientIds: opt('GOOGLE_CLIENT_IDS').split(',').map((s) => s.trim()).filter(Boolean),
    razorpay: {
      baseUrl: opt('RAZORPAY_BASE_URL', 'https://api.razorpay.com/v1'),
      keyId: opt('RAZORPAY_KEY_ID'),
      keySecret: opt('RAZORPAY_KEY_SECRET'),
      webhookSecret: opt('RAZORPAY_WEBHOOK_SECRET'),
    },
    cashfree: {
      baseUrl: opt('CASHFREE_BASE_URL', 'https://sandbox.cashfree.com/payout'),
      clientId: opt('CASHFREE_CLIENT_ID'),
      clientSecret: opt('CASHFREE_CLIENT_SECRET'),
    },
    s3: {
      bucket: opt('S3_BUCKET', 'plots315-docs'),
      endpoint: opt('S3_ENDPOINT'),
      region: opt('S3_REGION', 'ap-south-1'),
      accessKey: opt('S3_ACCESS_KEY'),
      secretKey: opt('S3_SECRET_KEY'),
    },
    fcmCredentialsFile: opt('FCM_CREDENTIALS_FILE'),
    jobsEnabled: opt('JOBS_ENABLED', 'true') === 'true',
  };
  if (c.jwtSecret.length < 32) throw new Error('JWT_SECRET must be at least 32 characters');
  if (c.env === 'prod' && c.otpProvider === 'log') throw new Error('OTP_PROVIDER=log is not allowed in prod');
  return c;
}

export type Config = ReturnType<typeof loadConfig>;
export const CONFIG = Symbol('CONFIG');
