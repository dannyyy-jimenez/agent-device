import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';
import type { CloudArtifact, CloudArtifactsResult } from '@agent-device/contracts/observability';
import {
  createCloudWebDriverCapabilities,
  type CloudWebDriverCapabilityOverrides,
  type CloudWebDriverProviderCapabilities,
} from './capabilities.ts';
import {
  createCloudWebDriverRuntime,
  type CloudWebDriverPlatform,
  type CloudWebDriverRuntimeOptions,
  type CloudWebDriverUploadApp,
} from './runtime.ts';
import type { DeviceLease, ProviderDeviceRuntime } from '@agent-device/contracts/device';
import { AppError } from '@agent-device/kernel/errors';
import { CLOUD_WEBDRIVER_PROVIDERS } from './providers.ts';
import {
  buildBrowserStackDeviceFeatureCapabilities,
  type BrowserStackDeviceFeatureFields,
} from './browserstack-device-features.ts';
import { agentDeviceRequestHeaders } from './request-headers.ts';
import { cloudArtifactsReadyOrPending } from './artifact-results.ts';
import {
  basicAuthHeader,
  resolveLeaseValue,
  trimTrailingSlash,
  type LeaseValue,
} from './webdriver-utils.ts';

const BROWSERSTACK_PROVIDER = CLOUD_WEBDRIVER_PROVIDERS.browserStack;
export const BROWSERSTACK_APP_AUTOMATE_ENDPOINT = 'https://hub-cloud.browserstack.com/wd/hub/';
export const BROWSERSTACK_APP_UPLOAD_ENDPOINT =
  'https://api-cloud.browserstack.com/app-automate/upload';
const BROWSERSTACK_SESSION_DETAILS_ENDPOINT =
  'https://api-cloud.browserstack.com/app-automate/sessions';
/** REST path suffix that returns the session HAR, appended after `<sessions-endpoint>/<sessionId>`. */
const BROWSERSTACK_NETWORK_LOGS_PATH_SUFFIX = 'networklogs';
/**
 * Network logs are build-scoped and served from the `api` host, not the `api-cloud` host the session
 * details come from — the same shape as `appium_logs_url` and `device_logs_url`. The session-details
 * endpoint returns an HTML 404 for this path, which reads as "not recorded" rather than "wrong URL".
 */
const BROWSERSTACK_BUILDS_ENDPOINT = 'https://api.browserstack.com/app-automate/builds';
export const BROWSERSTACK_CAPABILITY_OVERRIDES = {
  install: {
    support: 'partial',
    note: 'Local app artifacts are uploaded to BrowserStack App Automate, then installed with Appium.',
  },
  portReverse: {
    support: 'unsupported',
    note: 'Use BrowserStack Local for network tunneling; agent-device port reverse is not available.',
  },
  launchArgs: {
    support: 'supported',
    note: 'App Automate runs Appium, so a relaunch can carry iOS processArguments or Android intent arguments.',
  },
  artifacts: {
    support: 'supported',
    note: 'BrowserStack session details expose provider-hosted video, Appium logs, device logs, and dashboard links.',
  },
} as const satisfies CloudWebDriverCapabilityOverrides;

export type BrowserStackWebDriverRuntimeOptions = {
  clientVersion: string;
  username: string;
  accessKey: string;
  platform: CloudWebDriverPlatform;
  deviceName: string;
  osVersion: string;
  app?: string;
  projectName?: string;
  buildName?: LeaseValue<string>;
  sessionName?: LeaseValue<string>;
  deviceFeatures?: BrowserStackDeviceFeatureFields;
  webdriverCapabilities?:
    | Record<string, unknown>
    | ((lease: DeviceLease) => Record<string, unknown>);
  endpoint?: string | URL;
  uploadEndpoint?: string | URL;
  sessionDetailsEndpoint?: string | URL;
  deviceId?: CloudWebDriverRuntimeOptions['deviceId'];
  requestPolicy?: CloudWebDriverRuntimeOptions['requestPolicy'];
  prepareSession?: CloudWebDriverRuntimeOptions['prepareSession'];
};

export type BrowserStackCapabilitiesOptions = {
  deviceName: string;
  osVersion: string;
  app?: string;
  projectName?: string;
  buildName: string;
  sessionName: string;
  /** Vendor device-feature capabilities, already projected onto their `bstack:options` keys. */
  deviceFeatures?: Record<string, unknown>;
  configured?: Record<string, unknown>;
};

/**
 * @internal BrowserStack capability builder used by integration tests.
 */
export function getBrowserStackWebDriverCapabilities(
  platform: CloudWebDriverPlatform,
): CloudWebDriverProviderCapabilities {
  return createCloudWebDriverCapabilities({
    provider: BROWSERSTACK_PROVIDER,
    platform,
    overrides: BROWSERSTACK_CAPABILITY_OVERRIDES,
  });
}

/**
 * @internal BrowserStack runtime factory used by integration tests.
 */
export function createBrowserStackWebDriverRuntime(
  options: BrowserStackWebDriverRuntimeOptions,
): ProviderDeviceRuntime {
  const uploadEndpoint = options.uploadEndpoint ?? BROWSERSTACK_APP_UPLOAD_ENDPOINT;
  const artifactOptions = {
    clientVersion: options.clientVersion,
    username: options.username,
    accessKey: options.accessKey,
    endpoint: options.sessionDetailsEndpoint ?? BROWSERSTACK_SESSION_DETAILS_ENDPOINT,
  };
  return createCloudWebDriverRuntime({
    clientVersion: options.clientVersion,
    provider: BROWSERSTACK_PROVIDER,
    endpoint: options.endpoint ?? BROWSERSTACK_APP_AUTOMATE_ENDPOINT,
    platform: options.platform,
    deviceName: options.deviceName,
    auth: {
      username: options.username,
      accessKey: options.accessKey,
    },
    webdriverCapabilities: (lease) =>
      buildBrowserStackCapabilities({
        deviceName: options.deviceName,
        osVersion: options.osVersion,
        app: options.app,
        projectName: options.projectName,
        buildName: resolveLeaseValue(options.buildName, lease) ?? lease.runId,
        sessionName: resolveLeaseValue(options.sessionName, lease) ?? lease.leaseId,
        deviceFeatures: buildBrowserStackDeviceFeatureCapabilities(
          options.deviceFeatures ?? {},
          options.platform,
        ),
        configured: resolveConfiguredBrowserStackCapabilities(options, lease),
      }),
    uploadApp: createBrowserStackUploadApp({
      clientVersion: options.clientVersion,
      username: options.username,
      accessKey: options.accessKey,
      endpoint: uploadEndpoint,
    }),
    listArtifacts: async ({ provider, providerSessionId }) =>
      await listBrowserStackCloudArtifacts(provider, providerSessionId, artifactOptions),
    deviceId: options.deviceId,
    prepareSession: options.prepareSession,
    requestPolicy: options.requestPolicy,
    capabilityOverrides: BROWSERSTACK_CAPABILITY_OVERRIDES,
  });
}

export type BrowserStackSessionDetailsOptions = {
  clientVersion: string;
  username: string;
  accessKey: string;
  endpoint?: string | URL;
  /** Bounds the post-session wait for BrowserStack to finalise the network-log HAR. */
  networkLogsTimeoutMs?: number;
  networkLogsPollIntervalMs?: number;
};

export async function listBrowserStackCloudArtifacts(
  provider: string,
  providerSessionId: string | undefined,
  options: BrowserStackSessionDetailsOptions,
): Promise<CloudArtifactsResult | undefined> {
  if (!providerSessionId) return undefined;
  const details = await fetchBrowserStackSessionDetails(providerSessionId, options);
  const artifacts = mapBrowserStackArtifacts(provider, providerSessionId, details);
  return cloudArtifactsReadyOrPending({
    provider,
    providerSessionId,
    artifacts,
    pendingMessage: 'BrowserStack artifacts are not ready yet.',
  });
}

export type BrowserStackNetworkLogsResult = {
  /** REST URL the HAR was read from. */
  url: string;
  /** Parsed HAR document (`{ log: { entries: [...] } }`). */
  har: unknown;
  /** Count of `log.entries`, or 0 when the HAR carries none. */
  entryCount: number;
};

/**
 * BrowserStack finalises the session HAR some time after the session ends. Until it does, the
 * endpoint answers `200` with an empty `text/plain` body rather than a 404 — a pending state that no
 * status code distinguishes from "networkLogs was never enabled". The fetch polls before deciding,
 * and the terminal error names both causes instead of asserting the capability was off.
 */
const NETWORK_LOGS_FINALISE_TIMEOUT_MS = 90_000;
const NETWORK_LOGS_POLL_INTERVAL_MS = 3_000;

/**
 * Fetches the session network-log HAR from BrowserStack App Automate.
 *
 * Polls while the provider reports 404, which covers the post-session finalisation window. Any
 * other status is a lookup failure and fails immediately.
 */
export async function fetchBrowserStackNetworkLogs(
  sessionId: string,
  options: BrowserStackSessionDetailsOptions,
): Promise<BrowserStackNetworkLogsResult> {
  const buildId = await requireBrowserStackBuildId(sessionId, options);
  const url = browserStackNetworkLogsUrl(buildId, sessionId);
  const har = await pollBrowserStackNetworkLogs(url, sessionId, options);
  return { url, har, entryCount: readHarEntryCount(har) ?? 0 };
}

async function requireBrowserStackBuildId(
  sessionId: string,
  options: BrowserStackSessionDetailsOptions,
): Promise<string> {
  const details = await fetchBrowserStackSessionDetails(sessionId, options);
  const buildId = details.build_hashed_id;
  if (typeof buildId !== 'string' || buildId.length === 0) {
    throw new AppError(
      'COMMAND_FAILED',
      'BrowserStack session details named no build, so the network-log URL cannot be built.',
      { providerSessionId: sessionId },
    );
  }
  return buildId;
}

/**
 * Polls until the provider serves a parseable HAR.
 *
 * While BrowserStack is still finalising, the endpoint answers `200` with an empty `text/plain`
 * body — not a 404, and not a HAR. Both that and a 404 are treated as "not yet"; any other status
 * is a lookup failure and fails on the first response.
 */
async function pollBrowserStackNetworkLogs(
  url: string,
  sessionId: string,
  options: BrowserStackSessionDetailsOptions,
): Promise<unknown> {
  const interval = options.networkLogsPollIntervalMs ?? NETWORK_LOGS_POLL_INTERVAL_MS;
  const deadline = Date.now() + (options.networkLogsTimeoutMs ?? NETWORK_LOGS_FINALISE_TIMEOUT_MS);
  for (;;) {
    const response = await fetch(new URL(url), {
      headers: {
        ...agentDeviceRequestHeaders(options.clientVersion),
        Authorization: basicAuthHeader(options),
      },
    });
    if (!response.ok && response.status !== 404) {
      throw new AppError('COMMAND_FAILED', 'BrowserStack network-log HAR lookup failed.', {
        status: response.status,
        providerSessionId: sessionId,
      });
    }
    const har = response.ok
      ? ((await response.json().catch(() => undefined)) as unknown)
      : undefined;
    if (readHarEntryCount(har) !== undefined) return har;
    if (Date.now() >= deadline) throw networkLogsNotFinalisedError(sessionId);
    await setTimeout(interval);
  }
}

/** Names both causes: neither the status nor the empty body can tell them apart. */
function networkLogsNotFinalisedError(sessionId: string): AppError {
  return new AppError('COMMAND_FAILED', 'BrowserStack served no network-log HAR for the session.', {
    hint: 'Either networkLogs was not enabled — reconnect with connect browserstack --provider-network-logs — or the HAR has not finalised yet, so retry the export.',
    providerSessionId: sessionId,
  });
}

/** Returns the HAR entry count, or undefined when the body is not a HAR document. */
function readHarEntryCount(har: unknown): number | undefined {
  if (!har || typeof har !== 'object') return undefined;
  const log = (har as { log?: unknown }).log;
  if (!log || typeof log !== 'object') return undefined;
  const entries = (log as { entries?: unknown }).entries;
  return Array.isArray(entries) ? entries.length : undefined;
}

export type BrowserStackUploadOptions = {
  clientVersion: string;
  username: string;
  accessKey: string;
  endpoint?: string | URL;
};

export async function uploadBrowserStackApp(
  appPath: string,
  options: BrowserStackUploadOptions,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  const file = await fs.readFile(appPath);
  const form = new FormData();
  form.set('file', new Blob([file]), path.basename(appPath));
  const response = await fetch(options.endpoint ?? BROWSERSTACK_APP_UPLOAD_ENDPOINT, {
    method: 'POST',
    headers: {
      ...agentDeviceRequestHeaders(options.clientVersion),
      Authorization: basicAuthHeader(options),
    },
    body: form,
    signal,
  });
  const json = (await response.json()) as unknown;
  const appUrl = readBrowserStackAppUrl(json);
  if (!response.ok || !appUrl) {
    throw new AppError('COMMAND_FAILED', 'BrowserStack app upload failed.', {
      status: response.status,
      response: json,
    });
  }
  return appUrl;
}

export function createBrowserStackUploadApp(
  options: Required<BrowserStackUploadOptions>,
): CloudWebDriverUploadApp {
  return async ({ appPath, options: installOptions, signal }) => {
    const appReference = await uploadBrowserStackApp(appPath, options, signal);
    return {
      appReference,
      bundleId: installOptions?.appIdentifierHint,
      packageName: installOptions?.packageNameHint,
      launchTarget: installOptions?.appIdentifierHint ?? installOptions?.packageNameHint,
    };
  };
}

/**
 * Builds the BrowserStack session capabilities.
 *
 * The payload is W3C-only. Emitting the legacy JSONWP keys (`device`, `os_version`, `app`) alongside
 * `platformName`/`appium:*` makes BrowserStack resolve the ambiguity as JSONWP and discard
 * `bstack:options` wholesale — taking the project/build/session labels and every device-feature
 * capability with it, with no error on the wire.
 */
export function buildBrowserStackCapabilities(
  options: BrowserStackCapabilitiesOptions,
): Record<string, unknown> {
  const { 'bstack:options': configuredBstackOptions, ...configured } = options.configured ?? {};
  return {
    'appium:deviceName': options.deviceName,
    'appium:platformVersion': options.osVersion,
    ...(options.app ? { 'appium:app': options.app } : {}),
    ...configured,
    // Merged per key, never assigned: `configured` carrying its own `bstack:options` used to
    // replace the whole object and silently drop the session/build labels below.
    'bstack:options': {
      ...(options.projectName ? { projectName: options.projectName } : {}),
      buildName: options.buildName,
      sessionName: options.sessionName,
      ...(options.deviceFeatures ?? {}),
      ...asRecord(configuredBstackOptions),
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function resolveConfiguredBrowserStackCapabilities(
  options: BrowserStackWebDriverRuntimeOptions,
  lease: DeviceLease,
): Record<string, unknown> {
  return typeof options.webdriverCapabilities === 'function'
    ? options.webdriverCapabilities(lease)
    : (options.webdriverCapabilities ?? {});
}

async function fetchBrowserStackSessionDetails(
  sessionId: string,
  options: BrowserStackSessionDetailsOptions,
): Promise<Record<string, unknown>> {
  const endpoint = new URL(
    `${trimTrailingSlash(String(options.endpoint ?? BROWSERSTACK_SESSION_DETAILS_ENDPOINT))}/${sessionId}.json`,
  );
  const response = await fetch(endpoint, {
    headers: {
      ...agentDeviceRequestHeaders(options.clientVersion),
      Authorization: basicAuthHeader(options),
    },
  });
  const json = (await response.json()) as unknown;
  if (!response.ok || !json || typeof json !== 'object') {
    throw new AppError('COMMAND_FAILED', 'BrowserStack session details lookup failed.', {
      status: response.status,
      response: json,
    });
  }
  const details = (json as { automation_session?: unknown }).automation_session ?? json;
  return details && typeof details === 'object' ? (details as Record<string, unknown>) : {};
}

function mapBrowserStackArtifacts(
  provider: string,
  providerSessionId: string,
  details: Record<string, unknown>,
): CloudArtifact[] {
  return [
    browserStackUrlArtifact(
      provider,
      providerSessionId,
      details,
      'video_url',
      'video',
      'Session video',
    ),
    browserStackUrlArtifact(
      provider,
      providerSessionId,
      details,
      'appium_logs_url',
      'appium-log',
      'Appium logs',
    ),
    browserStackUrlArtifact(
      provider,
      providerSessionId,
      details,
      'device_logs_url',
      'device-log',
      'Device logs',
    ),
    browserStackUrlArtifact(
      provider,
      providerSessionId,
      details,
      'browser_url',
      'provider-session',
      'BrowserStack dashboard',
    ),
    browserStackUrlArtifact(
      provider,
      providerSessionId,
      details,
      'public_url',
      'provider-session',
      'Public session link',
    ),
    // Always advertised, never claimed ready: session details do not report whether networkLogs was
    // captured, and BrowserStack finalises the HAR some time after the session ends. Real
    // availability is resolved at fetch time by `agent-device network export`, which polls. The URL
    // needs Basic auth, unlike the pre-signed URLs above.
    {
      provider,
      providerSessionId,
      kind: 'raw',
      name: 'Network logs (HAR)',
      url: browserStackNetworkLogsUrl(String(details.build_hashed_id ?? ''), providerSessionId),
      contentType: 'application/json',
      extension: 'har',
      availability: 'pending',
      metadata: {
        format: 'har',
        requiresAuth: true,
        exportCommand: 'agent-device network export --out <path>',
      },
    },
  ].filter((artifact): artifact is CloudArtifact => artifact !== undefined);
}

/**
 * Builds the App Automate networklogs REST URL for a session.
 *
 * Build-scoped on the `api` host: `<builds>/<buildId>/sessions/<sessionId>/networklogs`.
 */
export function browserStackNetworkLogsUrl(
  buildId: string,
  sessionId: string,
  endpoint: string | URL = BROWSERSTACK_BUILDS_ENDPOINT,
): string {
  return `${trimTrailingSlash(String(endpoint))}/${buildId}/sessions/${sessionId}/${BROWSERSTACK_NETWORK_LOGS_PATH_SUFFIX}`;
}

function browserStackUrlArtifact(
  provider: string,
  providerSessionId: string,
  details: Record<string, unknown>,
  field: string,
  kind: CloudArtifact['kind'],
  name: string,
): CloudArtifact | undefined {
  const url = details[field];
  if (typeof url !== 'string' || url.length === 0) return undefined;
  return { provider, providerSessionId, kind, name, url, availability: 'ready' };
}

function readBrowserStackAppUrl(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const appUrl = (value as { app_url?: unknown }).app_url;
  return typeof appUrl === 'string' ? appUrl : undefined;
}
