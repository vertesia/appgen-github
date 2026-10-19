import { randomUUID } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const API_VERSION = '20260803';
const REQUEST_TIMEOUT_MS = 30_000;
const RETRYABLE_PROGRESS_STATUSES = new Set([429, 500, 502, 503, 504]);
const TERMINAL_STATUSES = new Set(['completed', 'failed']);

export class HttpError extends Error {
    constructor(message, status) {
        super(message);
        this.name = 'HttpError';
        this.status = status;
    }
}

function input(name, required = false) {
    const value = (process.env[`INPUT_${name.replaceAll('-', '_').toUpperCase()}`] || '').trim();
    if (required && !value) throw new Error(`Input ${name} is required.`);
    return value;
}

function parseBoolean(value, name) {
    if (value === 'true') return true;
    if (value === 'false') return false;
    throw new Error(`Input ${name} must be true or false.`);
}

function parsePositiveInteger(value, name) {
    if (!/^\d+$/.test(value) || Number(value) < 1) throw new Error(`Input ${name} must be a positive integer.`);
    return Number(value);
}

function isLoopback(hostname) {
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

export function normalizeServiceUrl(value, name) {
    let url;
    try {
        url = new URL(value);
    } catch {
        throw new Error(`${name} must be an absolute URL.`);
    }
    if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
        throw new Error(`${name} must be an origin without credentials, a path, a query, or a fragment.`);
    }
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname))) {
        throw new Error(`${name} must use HTTPS, except for a loopback development URL.`);
    }
    return url.origin;
}

export function deriveTokenServerUrl(serverUrl) {
    const url = new URL(serverUrl);
    if (url.hostname === 'localhost' || isLoopback(url.hostname)) {
        throw new Error('token-server-url is required when server-url uses a local development server.');
    }
    if (!url.hostname.startsWith('api.') && !url.hostname.startsWith('api-')) {
        throw new Error('token-server-url could not be derived from server-url; provide it explicitly.');
    }
    url.hostname = url.hostname.replace(/^api(?=[.-])/, 'sts');
    return url.origin;
}

function safeMessage(value) {
    return String(value).replace(/[\r\n]+/g, ' ').trim();
}

function commandValue(value) {
    return safeMessage(value).replaceAll('%', '%25').replaceAll(':', '%3A').replaceAll(',', '%2C');
}

function annotate(level, message) {
    process.stdout.write(`::${level}::${commandValue(message)}\n`);
}

function log(message) {
    process.stdout.write(`Vertesia: ${safeMessage(message)}\n`);
}

function mask(value) {
    if (value) process.stdout.write(`::add-mask::${commandValue(value)}\n`);
}

async function responseBody(response) {
    const text = await response.text();
    if (!text) return undefined;
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
}

function errorDetail(body) {
    if (typeof body === 'string') return safeMessage(body).slice(0, 1_000);
    if (!body || typeof body !== 'object') return '';
    const value = body.error_description ?? body.message ?? body.error;
    return typeof value === 'string' ? safeMessage(value).slice(0, 1_000) : '';
}

async function fetchJson(fetchImpl, url, init) {
    const response = await fetchImpl(url, {
        ...init,
        headers: { Accept: 'application/json', ...init.headers },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const body = await responseBody(response);
    if (!response.ok) {
        const detail = errorDetail(body);
        throw new HttpError(`Request failed with HTTP ${response.status}${detail ? `: ${detail}` : ''}`, response.status);
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw new Error('Vertesia returned an invalid JSON response.');
    }
    return body;
}

async function exchangeApiKey(fetchImpl, tokenServerUrl, apiKey) {
    const result = await fetchJson(fetchImpl, `${tokenServerUrl}/token/issue`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        },
    });
    if (typeof result.token !== 'string' || !result.token) {
        throw new Error('Vertesia token service did not return an access token.');
    }
    return result.token;
}

function validateBuildStart(value) {
    if (
        typeof value.workflow_id !== 'string' ||
        !value.workflow_id ||
        typeof value.run_id !== 'string' ||
        !value.run_id ||
        typeof value.app_id !== 'string' ||
        !value.app_id
    ) {
        throw new Error('Vertesia returned an invalid build-start response.');
    }
    return value;
}

function validateProgress(value) {
    const statuses = new Set(['queued', 'resolving', 'building', 'completed', 'failed']);
    if (!statuses.has(value.status) || typeof value.step !== 'string') {
        throw new Error('Vertesia returned an invalid build-progress response.');
    }
    return value;
}

export async function publishVersion(config, dependencies = {}) {
    const fetchImpl = dependencies.fetch ?? globalThis.fetch;
    const sleep = dependencies.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const now = dependencies.now ?? (() => Date.now());
    const onProgress = dependencies.onProgress ?? (() => {});

    let accessToken = config.credential;
    const exchange = async () => {
        accessToken = await exchangeApiKey(fetchImpl, config.tokenServerUrl, config.credential);
        dependencies.onAccessToken?.(accessToken);
    };
    if (config.credential.startsWith('sk-') || config.credential.startsWith('pk-')) await exchange();

    const authorizedRequest = async (url, init, retryAuth = true) => {
        try {
            return await fetchJson(fetchImpl, url, {
                ...init,
                headers: {
                    ...init.headers,
                    Authorization: `Bearer ${accessToken}`,
                    'x-api-version': API_VERSION,
                },
            });
        } catch (error) {
            if (retryAuth && error instanceof HttpError && error.status === 401 && accessToken !== config.credential) {
                await exchange();
                return authorizedRequest(url, init, false);
            }
            throw error;
        }
    };

    const buildUrl = `${config.serverUrl}/api/v1/apps/${encodeURIComponent(config.appId)}/builds`;
    const started = validateBuildStart(
        await authorizedRequest(buildUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                source_ref: config.commitSha,
                source_ref_type: 'commit',
                trigger: 'git_push',
            }),
        }),
    );

    if (!config.waitForCompletion) return { ...started, status: 'queued' };

    const progressUrl = `${buildUrl}/${encodeURIComponent(started.workflow_id)}/${encodeURIComponent(started.run_id)}/progress`;
    const deadline = now() + config.timeoutSeconds * 1_000;
    let previousLabel = '';

    while (now() <= deadline) {
        let progress;
        try {
            progress = validateProgress(await authorizedRequest(progressUrl, { method: 'GET', headers: {} }));
        } catch (error) {
            if (error instanceof HttpError && RETRYABLE_PROGRESS_STATUSES.has(error.status) && now() < deadline) {
                onProgress({ status: 'queued', step: `progress temporarily unavailable (HTTP ${error.status})` });
                await sleep(config.pollIntervalSeconds * 1_000);
                continue;
            }
            throw error;
        }

        const label = `${progress.status}:${progress.step}`;
        if (label !== previousLabel) {
            onProgress(progress);
            previousLabel = label;
        }
        if (TERMINAL_STATUSES.has(progress.status)) {
            if (progress.status === 'failed') {
                throw new Error(`Version build failed: ${safeMessage(progress.error || progress.step)}`);
            }
            return { ...started, ...progress };
        }
        await sleep(config.pollIntervalSeconds * 1_000);
    }

    throw new Error(`Version build did not finish within ${config.timeoutSeconds} seconds.`);
}

async function setOutput(name, value) {
    if (value === undefined || value === null || value === '') return;
    const outputPath = process.env.GITHUB_OUTPUT;
    if (!outputPath) throw new Error('GITHUB_OUTPUT is not available. This script must run as a GitHub Action step.');
    const delimiter = `vertesia_${randomUUID()}`;
    await appendFile(outputPath, `${name}<<${delimiter}\n${String(value)}\n${delimiter}\n`);
}

async function writeSummary(result) {
    if (!process.env.GITHUB_STEP_SUMMARY) return;
    const rows = [
        ['App', result.app_id],
        ['Status', result.status],
        ['Version', result.version_id],
        ['Source commit', result.source_commit],
        ['App URL', result.app_url],
    ].filter(([, value]) => value);
    const markdown = ['### Vertesia app version', '', '| Field | Value |', '| --- | --- |'];
    for (const [label, value] of rows) markdown.push(`| ${label} | ${safeMessage(value).replaceAll('|', '\\|')} |`);
    markdown.push('');
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `${markdown.join('\n')}\n`);
}

export async function runAction() {
    const credential = input('api-key', true);
    const appId = input('app-id', true);
    const commitSha = input('commit-sha') || (process.env.GITHUB_SHA || '').trim();
    if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/i.test(commitSha)) {
        throw new Error('commit-sha must be an exact 40- or 64-character hexadecimal Git commit.');
    }

    const serverUrl = normalizeServiceUrl(input('server-url', true), 'server-url');
    const configuredTokenServerUrl = input('token-server-url');
    const tokenServerUrl = configuredTokenServerUrl
        ? normalizeServiceUrl(configuredTokenServerUrl, 'token-server-url')
        : deriveTokenServerUrl(serverUrl);
    const waitForCompletion = parseBoolean(input('wait-for-completion', true), 'wait-for-completion');
    const timeoutSeconds = parsePositiveInteger(input('timeout-seconds', true), 'timeout-seconds');
    const pollIntervalSeconds = parsePositiveInteger(
        input('poll-interval-seconds', true),
        'poll-interval-seconds',
    );

    mask(credential);
    log(`starting version build for ${appId} at ${commitSha}`);
    const result = await publishVersion(
        {
            credential,
            appId,
            commitSha,
            serverUrl,
            tokenServerUrl,
            waitForCompletion,
            timeoutSeconds,
            pollIntervalSeconds,
        },
        {
            onAccessToken: mask,
            onProgress: (progress) => log(`${progress.status}: ${progress.step}`),
        },
    );

    await Promise.all([
        setOutput('workflow-id', result.workflow_id),
        setOutput('run-id', result.run_id),
        setOutput('status', result.status),
        setOutput('version-id', result.version_id),
        setOutput('source-commit', result.source_commit),
        setOutput('app-url', result.app_url),
    ]);
    await writeSummary(result);
    if (result.status === 'completed') annotate('notice', `Published Vertesia app version ${result.version_id}.`);
    else annotate('notice', `Started Vertesia app version build ${result.workflow_id}.`);
}

const isEntrypoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntrypoint) {
    runAction().catch((error) => {
        annotate('error', error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    });
}
