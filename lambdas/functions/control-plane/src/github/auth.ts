import { createSign, randomUUID } from 'node:crypto';
import { createAppAuth, type AppAuthentication, type InstallationAccessTokenAuthentication } from '@octokit/auth-app';
import type { OctokitOptions } from '@octokit/core';
import type { RequestInterface } from '@octokit/types';

// Define types that are not directly exported
type AppAuthOptions = { type: 'app' };
type InstallationAuthOptions = { type: 'installation'; installationId?: number };
// Use a more generalized AuthInterface to match what createAppAuth returns
type AuthInterface = {
  (options: AppAuthOptions): Promise<AppAuthentication>;
  (options: InstallationAuthOptions): Promise<InstallationAccessTokenAuthentication>;
};
type StrategyOptions = {
  appId: number;
  privateKey: string;
  installationId?: number;
  request?: RequestInterface;
  createJwt?: (appId: number, timeDifference: number) => Promise<{ jwt: string; expiresAt: string }>;
};
import { request } from '@octokit/request';
import { Octokit } from '@octokit/rest';
import { throttling } from '@octokit/plugin-throttling';
import { createChildLogger } from '@aws-github-runner/aws-powertools-util';
import { getParameter } from '@aws-github-runner/aws-ssm-util';
import { EndpointDefaults } from '@octokit/types';

const logger = createChildLogger('gh-auth');

function signJwt(appId: number, privateKey: string, timeDifference: number = 0): { jwt: string; expiresAt: string } {
  const now = Math.floor(Date.now() / 1000);
  const iat = now - 30 + timeDifference;
  const exp = iat + 600;

  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({ iat, exp, iss: String(appId), jti: randomUUID() }),
  ).toString('base64url');

  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  const signature = signer.sign(privateKey, 'base64url');

  return {
    jwt: `${header}.${payload}.${signature}`,
    expiresAt: new Date(exp * 1000).toISOString(),
  };
}

export async function createOctokitClient(token: string, ghesApiUrl = ''): Promise<Octokit> {
  const CustomOctokit = Octokit.plugin(throttling);
  const ocktokitOptions: OctokitOptions = {
    auth: token,
  };
  if (ghesApiUrl) {
    ocktokitOptions.baseUrl = ghesApiUrl;
    ocktokitOptions.previews = ['antiope'];
  }

  return new CustomOctokit({
    ...ocktokitOptions,
    userAgent: process.env.USER_AGENT || 'github-aws-runners',
    throttle: {
      onRateLimit: (retryAfter: number, options: Required<EndpointDefaults>, _octokit: unknown, retryCount: number) => {
        logger.warn(
          `GitHub rate limit: Request quota exhausted for request ${options.method} ${options.url}. Retry after ${retryAfter}s.`,
        );
        return retryCount < 1;
      },
      onSecondaryRateLimit: (retryAfter: number, options: Required<EndpointDefaults>, _octokit: unknown, retryCount: number) => {
        logger.warn(`GitHub rate limit: SecondaryRateLimit detected for request ${options.method} ${options.url}`);
        return retryCount < 1;
      },
    },
  });
}

export async function createGithubAppAuth(
  installationId: number | undefined,
  ghesApiUrl = '',
): Promise<AppAuthentication> {
  const auth = await createAuth(installationId, ghesApiUrl);
  const appAuthOptions: AppAuthOptions = { type: 'app' };
  return auth(appAuthOptions);
}

export async function createGithubInstallationAuth(
  installationId: number | undefined,
  ghesApiUrl = '',
): Promise<InstallationAccessTokenAuthentication> {
  const auth = await createAuth(installationId, ghesApiUrl);
  const installationAuthOptions: InstallationAuthOptions = { type: 'installation', installationId };
  return auth(installationAuthOptions);
}

async function createAuth(installationId: number | undefined, ghesApiUrl: string): Promise<AuthInterface> {
  const appId = parseInt(await getParameter(process.env.PARAMETER_GITHUB_APP_ID_NAME));
  const privateKey = Buffer.from(
    await getParameter(process.env.PARAMETER_GITHUB_APP_KEY_BASE64_NAME),
    'base64',
    // replace literal \n characters with new lines to allow the key to be stored as a
    // single line variable. This logic should match how the GitHub Terraform provider
    // processes private keys to retain compatibility between the projects
  )
    .toString()
    .replace(/\\n/g, '\n');

  let authOptions: StrategyOptions = {
    appId,
    privateKey,
    createJwt: async (_appId: number, timeDifference: number) => {
      return signJwt(appId, privateKey, timeDifference);
    },
  };
  if (installationId) authOptions = { ...authOptions, installationId };

  logger.debug(`GHES API URL: ${ghesApiUrl}`);
  if (ghesApiUrl) {
    authOptions.request = request.defaults({
      baseUrl: ghesApiUrl,
    });
  }
  return createAppAuth(authOptions);
}
