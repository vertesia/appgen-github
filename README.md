# Vertesia AppGen GitHub integration

This public repository contains the GitHub-facing components of Vertesia AppGen.

## Callback relay

The static relay in [`relay/`](relay/) handles both the GitHub OAuth callback and the GitHub App
post-installation setup callback. It has no backend, makes no network requests, and contains no
credentials.

GitHub Pages publishes it at:

```text
https://vertesia.github.io/appgen-github/relay/
```

Configure the Vertesia App Builder GitHub App with that exact URL for both:

```text
Callback URL: https://vertesia.github.io/appgen-github/relay/
Setup URL:    https://vertesia.github.io/appgen-github/relay/
```

Leave **Request user authorization (OAuth) during installation** disabled. Leave **Redirect on
update** disabled until AppGen handles installation updates.

Studio deployments must use the same URL for `APPGEN_GITHUB_APP_CALLBACK_URL`.

## Publish the relay

In **Settings > Pages**, choose **Deploy from a branch**, then select `main` and `/(root)`.

The root is intentionally used as the Pages source so the relay remains available under `/relay/`
while the future public GitHub Action can use the repository-level `action.yml` entry point.

## Security contract

- Do not add analytics, remote scripts, remote fonts, or remote images to the relay.
- Do not add a GitHub client secret, private key, access token, or Vertesia credential.
- OAuth codes and installation IDs are relayed only after the opener proves knowledge of the
  single-use state.
- The relay remains open with a loading state while Studio validates the callback and loads the
  authorized installations; the Studio opener closes it when that work finishes.
- Studio Server must validate the GitHub identity and installation returned through the relay.
- Treat `installation_id` as untrusted input and verify it through GitHub before accepting a
  repository binding.

