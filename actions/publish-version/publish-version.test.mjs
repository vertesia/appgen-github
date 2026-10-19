import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveTokenServerUrl, normalizeServiceUrl, publishVersion } from './publish-version.mjs';

const SHA = 'a'.repeat(40);

function json(body, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

function config(overrides = {}) {
    return {
        credential: 'sk-project-key',
        appId: 'customer-portal',
        commitSha: SHA,
        serverUrl: 'https://api.vertesia.io',
        tokenServerUrl: 'https://sts.vertesia.io',
        waitForCompletion: true,
        timeoutSeconds: 60,
        pollIntervalSeconds: 1,
        ...overrides,
    };
}

test('derives matching production and preview token service origins', () => {
    assert.equal(deriveTokenServerUrl('https://api.vertesia.io'), 'https://sts.vertesia.io');
    assert.equal(deriveTokenServerUrl('https://api-preview.eu1.vertesia.io'), 'https://sts-preview.eu1.vertesia.io');
    assert.throws(() => deriveTokenServerUrl('https://studio.example.com'), /provide it explicitly/);
});

test('accepts HTTPS and loopback HTTP service origins only', () => {
    assert.equal(normalizeServiceUrl('https://api.vertesia.io/', 'server-url'), 'https://api.vertesia.io');
    assert.equal(normalizeServiceUrl('http://localhost:8091', 'server-url'), 'http://localhost:8091');
    assert.throws(() => normalizeServiceUrl('http://api.example.com', 'server-url'), /must use HTTPS/);
    assert.throws(() => normalizeServiceUrl('https://api.example.com/path', 'server-url'), /must be an origin/);
});

test('exchanges the API key, builds the exact commit, and waits for completion', async () => {
    const requests = [];
    const progress = [];
    const responses = [
        json({ token: 'short-lived-token' }),
        json({ workflow_id: 'workflow-1', run_id: 'run-1', app_id: 'customer-portal' }),
        json({ status: 'building', step: 'building app source', updated_at: '2026-10-19T00:00:00Z' }),
        json({
            status: 'completed',
            step: 'completed',
            app_id: 'customer-portal',
            version_id: '20261019T000000000Z',
            source_commit: SHA,
            app_url: 'https://apps.example.com/customer-portal',
            updated_at: '2026-10-19T00:00:01Z',
        }),
    ];
    const result = await publishVersion(config(), {
        fetch: async (url, init) => {
            requests.push({ url: String(url), init });
            return responses.shift();
        },
        sleep: async () => {},
        onProgress: (value) => progress.push(value.status),
    });

    assert.equal(result.version_id, '20261019T000000000Z');
    assert.deepEqual(progress, ['building', 'completed']);
    assert.equal(requests[0].url, 'https://sts.vertesia.io/token/issue');
    assert.equal(requests[0].init.headers.Authorization, 'Bearer sk-project-key');
    assert.equal(requests[1].url, 'https://api.vertesia.io/api/v1/apps/customer-portal/builds');
    assert.equal(requests[1].init.headers.Authorization, 'Bearer short-lived-token');
    assert.equal(requests[1].init.headers['x-api-version'], '20260803');
    assert.deepEqual(JSON.parse(requests[1].init.body), {
        source_ref: SHA,
        source_ref_type: 'commit',
        trigger: 'git_push',
    });
});

test('can enqueue without polling', async () => {
    const requests = [];
    const result = await publishVersion(config({ credential: 'jwt-token', waitForCompletion: false }), {
        fetch: async (url, init) => {
            requests.push({ url: String(url), init });
            return json({ workflow_id: 'workflow-1', run_id: 'run-1', app_id: 'customer-portal' });
        },
    });

    assert.equal(result.status, 'queued');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].init.headers.Authorization, 'Bearer jwt-token');
});

test('fails when Vertesia reports a failed build', async () => {
    const responses = [
        json({ workflow_id: 'workflow-1', run_id: 'run-1', app_id: 'customer-portal' }),
        json({ status: 'failed', step: 'failed', error: 'bundle validation failed', updated_at: 'now' }),
    ];
    await assert.rejects(
        publishVersion(config({ credential: 'jwt-token' }), {
            fetch: async () => responses.shift(),
            sleep: async () => {},
        }),
        /Version build failed: bundle validation failed/,
    );
});
