import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import {
  browserStackNetworkLogsUrl,
  buildBrowserStackCapabilities,
  fetchBrowserStackNetworkLogs,
  listBrowserStackCloudArtifacts,
  uploadBrowserStackApp,
} from './browserstack.ts';

/**
 * BrowserStack resolves a payload carrying both legacy JSONWP keys and `bstack:options` as JSONWP,
 * and drops the vendor block without erroring. The hub accepts the request either way, so only an
 * explicit absence assertion keeps the regression from returning silently.
 */
const LEGACY_JSONWP_KEYS = ['device', 'os_version', 'app'] as const;

test('BrowserStack capabilities stay W3C so bstack:options survives the hub', () => {
  const capabilities = buildBrowserStackCapabilities({
    deviceName: 'Google Pixel 8',
    osVersion: '14.0',
    app: 'bs://app-id',
    projectName: 'agent-device',
    buildName: 'run-a',
    sessionName: 'lease-a',
    deviceFeatures: { timezone: 'New_York' },
    configured: { platformName: 'Android', 'appium:deviceName': 'Google Pixel 8' },
  });

  assert.deepEqual(capabilities, {
    platformName: 'Android',
    'appium:deviceName': 'Google Pixel 8',
    'appium:platformVersion': '14.0',
    'appium:app': 'bs://app-id',
    'bstack:options': {
      projectName: 'agent-device',
      buildName: 'run-a',
      sessionName: 'lease-a',
      timezone: 'New_York',
    },
  });

  for (const key of LEGACY_JSONWP_KEYS) {
    assert.ok(!(key in capabilities), `legacy JSONWP key "${key}" must not be emitted`);
  }
});

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

const NETWORK_LOGS_OPTIONS = {
  clientVersion: '0.0.0-test',
  username: 'user',
  accessKey: 'key',
} as const;

// Network logs are build-scoped on the `api` host, not session-scoped on `api-cloud`. The
// session-details host answers this path with an HTML 404, which the caller would otherwise report
// as "networkLogs was not enabled" — a wrong URL misdiagnosed as a missing capability.
test('network-log HAR URL is build-scoped on the api host', () => {
  assert.equal(
    browserStackNetworkLogsUrl('build-9', 'wd-1'),
    'https://api.browserstack.com/app-automate/builds/build-9/sessions/wd-1/networklogs',
  );
  assert.equal(
    browserStackNetworkLogsUrl('build-9', 'wd-1', 'https://hub.example/app-automate/builds/'),
    'https://hub.example/app-automate/builds/build-9/sessions/wd-1/networklogs',
  );
});

test('fetchBrowserStackNetworkLogs returns the HAR and entry count with basic auth', async () => {
  const har = { log: { entries: [{ request: {} }, { request: {} }] } };
  const requestedUrls: string[] = [];
  let authHeader: string | null | undefined;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    requestedUrls.push(url);
    authHeader = new Headers(init?.headers).get('authorization');
    // The build id is only known from session details, so the HAR needs that lookup first.
    return url.endsWith('/networklogs')
      ? new Response(JSON.stringify(har), { status: 200 })
      : new Response(JSON.stringify({ automation_session: { build_hashed_id: 'build-9' } }), {
          status: 200,
        });
  };

  const result = await fetchBrowserStackNetworkLogs('wd-1', NETWORK_LOGS_OPTIONS);

  assert.equal(result.entryCount, 2);
  assert.deepEqual(result.har, har);
  assert.equal(result.url, browserStackNetworkLogsUrl('build-9', 'wd-1'));
  assert.ok(requestedUrls.includes(browserStackNetworkLogsUrl('build-9', 'wd-1')));
  // Credentials ride the request, never the result.
  assert.equal(authHeader, `Basic ${Buffer.from('user:key').toString('base64')}`);
});

// BrowserStack answers 404 while it finalises the HAR after the session ends, which is
// indistinguishable by status from "networkLogs was never enabled". The fetch polls rather than
// deciding on the first response.
test('fetchBrowserStackNetworkLogs polls through the finalisation window', async () => {
  const har = { log: { entries: [{ request: {} }] } };
  let networkLogAttempts = 0;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (!url.endsWith('/networklogs')) {
      return new Response(JSON.stringify({ automation_session: { build_hashed_id: 'build-9' } }), {
        status: 200,
      });
    }
    networkLogAttempts += 1;
    // Still finalising: BrowserStack answers 200 with an empty body, not a 404.
    return networkLogAttempts === 1
      ? new Response('', { status: 200 })
      : new Response(JSON.stringify(har), { status: 200 });
  };

  const result = await fetchBrowserStackNetworkLogs('wd-1', {
    ...NETWORK_LOGS_OPTIONS,
    networkLogsTimeoutMs: 100,
    networkLogsPollIntervalMs: 1,
  });

  assert.equal(networkLogAttempts, 2);
  assert.equal(result.entryCount, 1);
});

test('fetchBrowserStackNetworkLogs names both causes once the wait is exhausted', async () => {
  globalThis.fetch = async (input) =>
    String(input).endsWith('/networklogs')
      ? new Response('', { status: 200 })
      : new Response(JSON.stringify({ automation_session: { build_hashed_id: 'build-9' } }), {
          status: 200,
        });

  await assert.rejects(
    fetchBrowserStackNetworkLogs('wd-1', {
      ...NETWORK_LOGS_OPTIONS,
      networkLogsTimeoutMs: 5,
      networkLogsPollIntervalMs: 1,
    }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'COMMAND_FAILED');
      // A status alone cannot tell the two apart, so the hint must not assert either one.
      assert.match(String(error.details?.hint), /networkLogs was not enabled/);
      assert.match(String(error.details?.hint), /has not finalised yet/);
      return true;
    },
  );
});

// A non-404 is a lookup failure, not a pending HAR — it must fail on the first response.
test('fetchBrowserStackNetworkLogs does not poll a non-404 failure', async () => {
  let networkLogAttempts = 0;
  globalThis.fetch = async (input) => {
    if (!String(input).endsWith('/networklogs')) {
      return new Response(JSON.stringify({ automation_session: { build_hashed_id: 'build-9' } }), {
        status: 200,
      });
    }
    networkLogAttempts += 1;
    return new Response('Server Error', { status: 500 });
  };

  await assert.rejects(
    fetchBrowserStackNetworkLogs('wd-1', {
      ...NETWORK_LOGS_OPTIONS,
      networkLogsTimeoutMs: 1000,
      networkLogsPollIntervalMs: 1,
    }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.match(error.message, /lookup failed/);
      return true;
    },
  );
  assert.equal(networkLogAttempts, 1);
});

test('cloud artifacts list advertises the network-log HAR entry', async () => {
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        automation_session: { video_url: 'https://v/1.mp4', build_hashed_id: 'build-9' },
      }),
      { status: 200 },
    );

  const result = await listBrowserStackCloudArtifacts('browserstack', 'wd-1', NETWORK_LOGS_OPTIONS);

  const networkLogs = result?.cloudArtifacts.find(
    (artifact) => artifact.metadata?.format === 'har',
  );
  assert.ok(networkLogs, 'network-log HAR artifact must be listed');
  assert.equal(networkLogs.kind, 'raw');
  // Never claimed ready: BrowserStack finalises the HAR after the session ends.
  assert.equal(networkLogs.availability, 'pending');
  assert.equal(networkLogs.url, browserStackNetworkLogsUrl('build-9', 'wd-1'));
  assert.equal(networkLogs.providerSessionId, 'wd-1');
  assert.equal(networkLogs.metadata?.requiresAuth, true);
});

test('BrowserStack upload aborts while the provider request is in flight', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-device-browserstack-upload-'));
  const appPath = path.join(tempDir, 'App.apk');
  const controller = new AbortController();
  const abortReason = new Error('request cancelled during BrowserStack upload');
  try {
    await fs.writeFile(appPath, 'placeholder');
    globalThis.fetch = async (_input, init) =>
      await new Promise<Response>((_resolve, reject) => {
        assert.equal(init?.signal, controller.signal);
        if (init?.signal?.aborted) {
          reject(init.signal.reason);
          return;
        }
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });

    const pending = uploadBrowserStackApp(
      appPath,
      {
        clientVersion: '0.0.0-test',
        username: 'user',
        accessKey: 'key',
      },
      controller.signal,
    );
    await Promise.resolve();
    controller.abort(abortReason);

    await assert.rejects(pending, (error: unknown) => error === abortReason);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
