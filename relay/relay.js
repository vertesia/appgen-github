const FLOW_PROTOCOLS = {
    oauth: {
        ready: 'appgen-github-oauth-relay-ready',
        ack: 'appgen-github-oauth-relay-ack',
        result: 'appgen-github-oauth-relay-result',
    },
    setup: {
        ready: 'appgen-github-setup-relay-ready',
        ack: 'appgen-github-setup-relay-ack',
        result: 'appgen-github-setup-relay-result',
    },
};

const MAX_STATE_LENGTH = 512;
const MAX_CODE_LENGTH = 4096;
const MAX_ERROR_LENGTH = 512;
const MAX_INSTALLATION_ID_LENGTH = 32;
const MAX_SETUP_ACTION_LENGTH = 64;

function boundedParameter(query, name, maxLength) {
    const value = query.get(name);
    return value && value.length <= maxLength ? value : undefined;
}

function parseCallback(search) {
    const query = new URLSearchParams(search);
    const state = boundedParameter(query, 'state', MAX_STATE_LENGTH);
    if (!state) throw new Error('GitHub did not return a valid transaction state.');

    const code = boundedParameter(query, 'code', MAX_CODE_LENGTH);
    const providerError =
        boundedParameter(query, 'error_description', MAX_ERROR_LENGTH) ??
        boundedParameter(query, 'error', MAX_ERROR_LENGTH);
    const installationId = boundedParameter(query, 'installation_id', MAX_INSTALLATION_ID_LENGTH);
    const setupAction = boundedParameter(query, 'setup_action', MAX_SETUP_ACTION_LENGTH);
    const isOAuth = Boolean(code || providerError);
    const isSetup = Boolean(installationId || setupAction);

    if (isOAuth === isSetup) throw new Error('GitHub returned an unrecognized callback.');

    if (isOAuth) {
        return {
            flow: 'oauth',
            payload: {
                type: FLOW_PROTOCOLS.oauth.result,
                flow: 'oauth',
                state,
                ...(providerError ? { error: providerError } : { code }),
            },
        };
    }

    return {
        flow: 'setup',
        payload: {
            type: FLOW_PROTOCOLS.setup.result,
            flow: 'setup',
            state,
            ...(installationId && { installation_id: installationId }),
            ...(setupAction && { setup_action: setupAction }),
        },
    };
}

function showResult(title, message, isError = false) {
    document.getElementById('brand-mark').classList.remove('is-loading');
    document.getElementById('relay').setAttribute('aria-busy', 'false');
    document.getElementById('title').textContent = title;
    document.getElementById('message').textContent = message;
    document.getElementById('close').hidden = false;
    if (isError) document.title = 'GitHub connection could not be returned';
}

function startRelay() {
    let callback;
    try {
        callback = parseCallback(window.location.search);
    } catch (error) {
        const message = error instanceof Error ? error.message : 'GitHub returned an invalid callback.';
        showResult('Unable to return to App Builder', message, true);
        return;
    } finally {
        // Keep short-lived authorization data out of the visible URL and browser history entry.
        window.history.replaceState(null, '', `${window.location.pathname}${window.location.hash}`);
    }

    if (!window.opener) {
        showResult('App Builder is not available', 'Open this page from Vertesia App Builder and try again.', true);
        return;
    }

    const protocol = FLOW_PROTOCOLS[callback.flow];
    const opener = window.opener;
    const onMessage = (event) => {
        const message = event.data;
        if (
            event.source !== opener ||
            !event.origin ||
            event.origin === 'null' ||
            typeof message !== 'object' ||
            message === null ||
            message.type !== protocol.ack ||
            message.state !== callback.payload.state ||
            (message.flow !== undefined && message.flow !== callback.flow)
        ) {
            return;
        }

        window.removeEventListener('message', onMessage);
        opener.postMessage(callback.payload, event.origin);
        showResult('Returned to App Builder', 'This window can now close.');
        window.setTimeout(() => window.close(), 50);
    };

    window.addEventListener('message', onMessage);
    // READY contains no callback data. The opener must prove knowledge of the single-use state
    // before the relay sends the GitHub response to that opener's exact origin.
    opener.postMessage({ type: protocol.ready, flow: callback.flow }, '*');
}

document.getElementById('close').addEventListener('click', () => window.close());
startRelay();
