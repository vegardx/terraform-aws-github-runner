import { createAppAuth } from '@octokit/auth-app';
import { StrategyOptions } from '@octokit/auth-app/dist-types/types';
import { request } from '@octokit/request';
import { RequestInterface, RequestParameters } from '@octokit/types';
import { getParameter } from '@aws-github-runner/aws-ssm-util';
import * as nock from 'nock';

import { createGithubAppAuth, createOctokitClient, createEnterprisePATClient } from './auth';
import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';

type MockProxy<T> = T & {
  mockImplementation: (fn: (...args: T[]) => T) => MockProxy<T>;
  mockResolvedValue: (value: T) => MockProxy<T>;
  mockRejectedValue: (value: T) => MockProxy<T>;
  mockReturnValue: (value: T) => MockProxy<T>;
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mock = <T>(implementation?: any): MockProxy<T> => vi.fn(implementation) as any;

vi.mock('@aws-github-runner/aws-ssm-util');
vi.mock('@octokit/auth-app');

const cleanEnv = process.env;
const ENVIRONMENT = 'dev';
const GITHUB_APP_ID = '1';
const PARAMETER_GITHUB_APP_ID_NAME = `/actions-runner/${ENVIRONMENT}/github_app_id`;
const PARAMETER_GITHUB_APP_KEY_BASE64_NAME = `/actions-runner/${ENVIRONMENT}/github_app_key_base64`;

const mockedGet = vi.mocked(getParameter);

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  process.env = { ...cleanEnv };
  process.env.PARAMETER_GITHUB_APP_ID_NAME = PARAMETER_GITHUB_APP_ID_NAME;
  process.env.PARAMETER_GITHUB_APP_KEY_BASE64_NAME = PARAMETER_GITHUB_APP_KEY_BASE64_NAME;
  nock.disableNetConnect();
});

describe('Test createOctoClient', () => {
  it('Creates app client to GitHub public', async () => {
    // Arrange
    const token = '123456';

    // Act
    const result = await createOctokitClient(token);

    // Assert
    expect(result.request.endpoint.DEFAULTS.baseUrl).toBe('https://api.github.com');
  });

  it('Creates app client to GitHub ES', async () => {
    // Arrange
    const enterpriseServer = 'https://github.enterprise.notgoingtowork';
    const token = '123456';

    // Act
    const result = await createOctokitClient(token, enterpriseServer);

    // Assert
    expect(result.request.endpoint.DEFAULTS.baseUrl).toBe(enterpriseServer);
    expect(result.request.endpoint.DEFAULTS.mediaType.previews).toStrictEqual(['antiope']);
  });
});

describe('Test createGithubAppAuth', () => {
  const mockedCreatAppAuth = vi.mocked(createAppAuth);
  let mockedRequestInterface: MockProxy<RequestInterface>;

  const installationId = 1;
  const authType = 'app';
  const token = '123456';
  const decryptedValue = 'decryptedValue';
  const b64 = Buffer.from(decryptedValue, 'binary').toString('base64');

  beforeEach(() => {
    process.env.ENVIRONMENT = ENVIRONMENT;
  });

  it('Creates auth object with line breaks in SSH key.', async () => {
    const b64PrivateKeyWithLineBreaks = Buffer.from(decryptedValue + '\n' + decryptedValue, 'binary').toString(
      'base64',
    );
    mockedGet.mockResolvedValueOnce(GITHUB_APP_ID).mockResolvedValueOnce(b64PrivateKeyWithLineBreaks);

    const mockedAuth = vi.fn();
    mockedAuth.mockResolvedValue({ token });
    const mockWithHook = Object.assign(mockedAuth, { hook: vi.fn() });
    mockedCreatAppAuth.mockReturnValue(mockWithHook);

    await createGithubAppAuth(installationId);

    expect(mockedCreatAppAuth).toBeCalledTimes(1);
    expect(mockedCreatAppAuth).toBeCalledWith(
      expect.objectContaining({
        appId: parseInt(GITHUB_APP_ID),
        installationId,
        createJwt: expect.any(Function),
      }),
    );
    expect(mockedCreatAppAuth).toBeCalledWith(
      expect.not.objectContaining({ privateKey: expect.anything() }),
    );
  });

  it('Creates auth object for public GitHub', async () => {
    mockedGet.mockResolvedValueOnce(GITHUB_APP_ID).mockResolvedValueOnce(b64);

    const mockedAuth = vi.fn();
    mockedAuth.mockResolvedValue({ token });
    const mockWithHook = Object.assign(mockedAuth, { hook: vi.fn() });
    mockedCreatAppAuth.mockReturnValue(mockWithHook);

    const result = await createGithubAppAuth(installationId);

    expect(getParameter).toBeCalledWith(PARAMETER_GITHUB_APP_ID_NAME);
    expect(getParameter).toBeCalledWith(PARAMETER_GITHUB_APP_KEY_BASE64_NAME);

    expect(mockedCreatAppAuth).toBeCalledTimes(1);
    expect(mockedCreatAppAuth).toBeCalledWith(
      expect.objectContaining({
        appId: parseInt(GITHUB_APP_ID),
        installationId,
        createJwt: expect.any(Function),
      }),
    );
    expect(mockedCreatAppAuth).toBeCalledWith(
      expect.not.objectContaining({ privateKey: expect.anything() }),
    );
    expect(mockedAuth).toBeCalledWith({ type: authType });
    expect(result.token).toBe(token);
  });

  it('Creates auth object for Enterprise Server', async () => {
    const githubServerUrl = 'https://github.enterprise.notgoingtowork';

    mockedRequestInterface = mock<RequestInterface>();
    vi.spyOn(request, 'defaults').mockImplementation(
      () => mockedRequestInterface as RequestInterface<object & RequestParameters>,
    );

    mockedGet.mockResolvedValueOnce(GITHUB_APP_ID).mockResolvedValueOnce(b64);
    const mockedAuth = vi.fn();
    mockedAuth.mockResolvedValue({ token });
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    mockedCreatAppAuth.mockImplementation((authOptions: StrategyOptions) => {
      return Object.assign(mockedAuth, { hook: vi.fn() });
    });

    const result = await createGithubAppAuth(installationId, githubServerUrl);

    expect(getParameter).toBeCalledWith(PARAMETER_GITHUB_APP_ID_NAME);
    expect(getParameter).toBeCalledWith(PARAMETER_GITHUB_APP_KEY_BASE64_NAME);

    expect(mockedCreatAppAuth).toBeCalledTimes(1);
    expect(mockedCreatAppAuth).toBeCalledWith(
      expect.objectContaining({
        appId: parseInt(GITHUB_APP_ID),
        installationId,
        createJwt: expect.any(Function),
        request: mockedRequestInterface,
      }),
    );
    expect(mockedCreatAppAuth).toBeCalledWith(
      expect.not.objectContaining({ privateKey: expect.anything() }),
    );
    expect(mockedAuth).toBeCalledWith({ type: authType });
    expect(result.token).toBe(token);
  });

  it('Creates auth object for Enterprise Server with no ID', async () => {
    const githubServerUrl = 'https://github.enterprise.notgoingtowork';

    mockedRequestInterface = mock<RequestInterface>();
    vi.spyOn(request, 'defaults').mockImplementation(
      () => mockedRequestInterface as RequestInterface<object & RequestParameters>,
    );

    const installationId = undefined;

    mockedGet.mockResolvedValueOnce(GITHUB_APP_ID).mockResolvedValueOnce(b64);
    const mockedAuth = vi.fn();
    mockedAuth.mockResolvedValue({ token });
    const mockWithHook = Object.assign(mockedAuth, { hook: vi.fn() });
    mockedCreatAppAuth.mockReturnValue(mockWithHook);

    const result = await createGithubAppAuth(installationId, githubServerUrl);

    expect(getParameter).toBeCalledWith(PARAMETER_GITHUB_APP_ID_NAME);
    expect(getParameter).toBeCalledWith(PARAMETER_GITHUB_APP_KEY_BASE64_NAME);

    expect(mockedCreatAppAuth).toBeCalledTimes(1);
    expect(mockedCreatAppAuth).toBeCalledWith(
      expect.objectContaining({
        appId: parseInt(GITHUB_APP_ID),
        createJwt: expect.any(Function),
        request: mockedRequestInterface,
      }),
    );
    expect(mockedCreatAppAuth).toBeCalledWith(
      expect.not.objectContaining({ privateKey: expect.anything() }),
    );
    expect(mockedAuth).toBeCalledWith({ type: authType });
    expect(result.token).toBe(token);
  });
});

describe('JWT with jti claim', () => {
  const mockedCreatAppAuth = vi.mocked(createAppAuth);
  const token = '123456';

  let rsaPrivateKey: string;
  let b64Key: string;

  beforeAll(async () => {
    const { generateKeyPairSync } = await import('node:crypto');
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    rsaPrivateKey = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    b64Key = Buffer.from(rsaPrivateKey).toString('base64');
  });

  beforeEach(() => {
    process.env.ENVIRONMENT = 'dev';
  });

  it('passes createJwt callback to createAppAuth', async () => {
    mockedGet.mockResolvedValueOnce('1').mockResolvedValueOnce(b64Key);

    const mockedAuth = vi.fn();
    mockedAuth.mockResolvedValue({ token });
    const mockWithHook = Object.assign(mockedAuth, { hook: vi.fn() });
    mockedCreatAppAuth.mockReturnValue(mockWithHook);

    await createGithubAppAuth(1);

    expect(mockedCreatAppAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        createJwt: expect.any(Function),
      }),
    );
    expect(mockedCreatAppAuth).toHaveBeenCalledWith(
      expect.not.objectContaining({ privateKey: expect.anything() }),
    );
  });

  it('createJwt callback returns { jwt, expiresAt }', async () => {
    let capturedCreateJwt: ((appId: number, timeDifference: number) => Promise<{ jwt: string; expiresAt: string }>) | undefined;
    mockedCreatAppAuth.mockImplementation((options: any) => {
      capturedCreateJwt = options.createJwt;
      const mockedAuth = vi.fn();
      mockedAuth.mockResolvedValue({ token });
      return Object.assign(mockedAuth, { hook: vi.fn() });
    });

    mockedGet.mockResolvedValueOnce('1').mockResolvedValueOnce(b64Key);

    await createGithubAppAuth(1);

    expect(capturedCreateJwt).toBeDefined();
    const result = await capturedCreateJwt!(1, 0);
    expect(result).toHaveProperty('jwt');
    expect(result).toHaveProperty('expiresAt');
    expect(typeof result.jwt).toBe('string');
    expect(result.jwt.split('.')).toHaveLength(3);
    expect(typeof result.expiresAt).toBe('string');
    expect(new Date(result.expiresAt).toISOString()).toBe(result.expiresAt);
  });
});

describe('Test createEnterprisePATClient', () => {
  const PARAMETER_ENTERPRISE_PAT_NAME = `/actions-runner/${ENVIRONMENT}/enterprise_pat`;
  const pat = 'ghp_enterprise_pat_token_123';

  beforeEach(() => {
    process.env.PARAMETER_ENTERPRISE_PAT_NAME = PARAMETER_ENTERPRISE_PAT_NAME;
    vi.restoreAllMocks();
  });

  it('Reads PAT from SSM and creates Octokit client for public GitHub', async () => {
    mockedGet.mockResolvedValueOnce(pat);

    const result = await createEnterprisePATClient();

    expect(getParameter).toBeCalledWith(PARAMETER_ENTERPRISE_PAT_NAME);
    expect(result).toBeDefined();
    expect(result.request.endpoint.DEFAULTS.baseUrl).toBe('https://api.github.com');
  });

  it('Reads PAT from SSM and creates Octokit client for GHES', async () => {
    const ghesApiUrl = 'https://github.enterprise.notgoingtowork';
    mockedGet.mockResolvedValueOnce(pat);

    const result = await createEnterprisePATClient(ghesApiUrl);

    expect(getParameter).toBeCalledWith(PARAMETER_ENTERPRISE_PAT_NAME);
    expect(result).toBeDefined();
    expect(result.request.endpoint.DEFAULTS.baseUrl).toBe(ghesApiUrl);
  });

  it('Throws when PARAMETER_ENTERPRISE_PAT_NAME is not set', async () => {
    delete process.env.PARAMETER_ENTERPRISE_PAT_NAME;

    await expect(createEnterprisePATClient()).rejects.toThrow(
      'PARAMETER_ENTERPRISE_PAT_NAME environment variable is not set',
    );
  });
});
