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

test('network-log HAR URL is built from the session-details base', () => {
  assert.equal(
    browserStackNetworkLogsUrl('wd-1'),
    'https://api-cloud.browserstack.com/app-automate/sessions/wd-1/networklogs',
  );
  assert.equal(
    browserStackNetworkLogsUrl('wd-1', 'https://hub.example/app-automate/sessions/'),
    'https://hub.example/app-automate/sessions/wd-1/networklogs',
  );
});

test('fetchBrowserStackNetworkLogs returns the HAR and entry count with basic auth', async () => {
  const har = { log: { entries: [{ request: {} }, { request: {} }] } };
  let requestedUrl: string | undefined;
  let authHeader: string | null | undefined;
  globalThis.fetch = async (input, init) => {
    requestedUrl = String(input);
    authHeader = new Headers(init?.headers).get('authorization');
    return new Response(JSON.stringify(har), { status: 200 });
  };

  const result = await fetchBrowserStackNetworkLogs('wd-1', NETWORK_LOGS_OPTIONS);

  assert.equal(result.entryCount, 2);
  assert.deepEqual(result.har, har);
  assert.equal(requestedUrl, browserStackNetworkLogsUrl('wd-1'));
  // Credentials ride the request, never the result.
  assert.equal(authHeader, `Basic ${Buffer.from('user:key').toString('base64')}`);
});

test('fetchBrowserStackNetworkLogs fails clearly when networkLogs was not enabled', async () => {
  globalThis.fetch = async () => new Response('Not Found', { status: 404 });

  await assert.rejects(
    fetchBrowserStackNetworkLogs('wd-1', NETWORK_LOGS_OPTIONS),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'COMMAND_FAILED');
      assert.match(error.message, /networkLogs was not enabled/);
      assert.match(String(error.details?.hint), /--provider-network-logs/);
      return true;
    },
  );
});

test('cloud artifacts list advertises the network-log HAR entry', async () => {
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ automation_session: { video_url: 'https://v/1.mp4' } }), {
      status: 200,
    });

  const result = await listBrowserStackCloudArtifacts('browserstack', 'wd-1', NETWORK_LOGS_OPTIONS);

  const networkLogs = result?.cloudArtifacts.find(
    (artifact) => artifact.metadata?.format === 'har',
  );
  assert.ok(networkLogs, 'network-log HAR artifact must be listed');
  assert.equal(networkLogs.kind, 'raw');
  assert.equal(networkLogs.url, browserStackNetworkLogsUrl('wd-1'));
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
