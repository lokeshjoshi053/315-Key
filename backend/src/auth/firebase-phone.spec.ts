import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import { AuthService } from './auth';

// Firebase Phone Auth token checks, with a local signing key in place of Google's.
describe('AuthService.firebasePhone', () => {
  const PROJECT = 'testing-b9196';
  let key: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
  let svc: AuthService;
  const created: string[] = [];

  beforeAll(async () => {
    const pair = await generateKeyPair('RS256');
    key = pair.privateKey;
    const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256' };
    const db = { tx: (fn: (c: unknown) => unknown) => fn({}) };
    const users = { findBy: async () => null, create: async (_c: unknown, u: { mobile: string }) => (created.push(u.mobile), { id: 'u1', role: 'USER', active: true, name: null }) };
    const tokens = { issue: async () => ({ accessToken: 'a', refreshToken: 'r', expiresIn: 900 }) };
    svc = new AuthService(db as any, users as any, tokens as any, {} as any, { firebaseProjectId: PROJECT } as any);
    (svc as any).firebaseJwks = createLocalJWKSet({ keys: [jwk] });
  });

  const token = (claims: object, aud = PROJECT) =>
    new SignJWT({ ...claims }).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuer(`https://securetoken.google.com/${aud}`).setAudience(aud).setSubject('fb1').setIssuedAt().setExpirationTime('5m').sign(key);

  it('signs in an Indian number and strips +91', async () => {
    const r = await svc.firebasePhone({ idToken: await token({ phone_number: '+919876543210' }) });
    expect(r).toMatchObject({ accessToken: 'a', isNewUser: true, profileComplete: false });
    expect(created).toEqual(['9876543210']);
  });

  it('rejects a token for another Firebase project', async () => {
    await expect(svc.firebasePhone({ idToken: await token({ phone_number: '+919876543210' }, 'other') })).rejects.toMatchObject({ code: 'FIREBASE_TOKEN_INVALID' });
  });

  it('rejects non-Indian or missing numbers', async () => {
    await expect(svc.firebasePhone({ idToken: await token({ phone_number: '+14155550100' }) })).rejects.toMatchObject({ code: 'PHONE_NOT_SUPPORTED' });
    await expect(svc.firebasePhone({ idToken: await token({ email: 'a@b.c' }) })).rejects.toMatchObject({ code: 'PHONE_NOT_SUPPORTED' });
  });
});
