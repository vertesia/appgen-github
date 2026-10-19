# Vertesia App Builder for GitHub

This repository contains the public GitHub components used by Vertesia App Builder:

- [`relay/`](relay/) contains the static GitHub callback relay.
- [`actions/publish-version/`](actions/publish-version/) contains the GitHub Action that creates an
  immutable Vertesia app version from a Git commit.

## OAuth callback relay

GitHub redirects OAuth and GitHub App installation callbacks to the static page in [`relay/`](relay/).
The relay verifies the single-use transaction state with the App Builder window and forwards the
callback result to that window using `postMessage`.

The relay is only static HTML, CSS, JavaScript, and an image. It has no backend, makes no network
requests, and contains no client secret, private key, access token, Vertesia credential, or other
sensitive information.

It is published at:

```text
https://vertesia.github.io/appgen-github/relay/
```

## Publish a version from GitHub Actions

The action in [`actions/publish-version/`](actions/publish-version/) creates a Vertesia app version
from the exact commit that triggered a GitHub workflow. Vertesia reads that commit through the
GitHub App installation already connected to the App Builder application. The action does not push
to the repository and does not promote the resulting version.

Create a project API key in Vertesia with permission to manage applications, save it as the
`VERTESIA_API_KEY` GitHub Actions secret, and add this step after the repository's build and test
steps:

```yaml
name: Publish Vertesia app version

on:
  push:
    branches: [main]

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - name: Publish app version
        id: publish
        uses: vertesia/appgen-github/actions/publish-version@main
        with:
          api-key: ${{ secrets.VERTESIA_API_KEY }}
          app-id: customer-portal
          commit-sha: ${{ github.sha }}

      - name: Show published version
        run: echo "Published ${{ steps.publish.outputs.version-id }}"
```

The API key determines the Vertesia account and project. The `app-id` must identify an App Builder
application in that project whose GitHub source is this repository.

For a pull-request workflow, pass the pull request's head commit when the version should represent
the contributor branch rather than GitHub's temporary merge commit:

```yaml
commit-sha: ${{ github.event.pull_request.head.sha }}
```

### Inputs

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `api-key` | Yes | | Vertesia project API key stored as a GitHub Actions secret. |
| `app-id` | Yes | | App Builder application ID. |
| `commit-sha` | No | `GITHUB_SHA` | Exact 40- or 64-character Git commit to build. |
| `server-url` | No | `https://api.vertesia.io` | Vertesia API origin. |
| `token-server-url` | No | Derived from `server-url` | Vertesia token-service origin; useful for custom environments. |
| `wait-for-completion` | No | `true` | Wait for the version build and fail the job if it fails. |
| `timeout-seconds` | No | `3600` | Maximum time to wait for the build. |
| `poll-interval-seconds` | No | `5` | Delay between build-progress requests. |

### Outputs

| Output | Description |
| --- | --- |
| `workflow-id` | Vertesia build workflow ID. |
| `run-id` | Vertesia build workflow run ID. |
| `status` | Last build status reported by Vertesia. |
| `version-id` | Created immutable version ID. Available after a completed build. |
| `source-commit` | Exact source commit recorded by the version. |
| `app-url` | URL of the created version when the app has a browser entry point. |

A separate promotion action may be added under `actions/` later. Creating a version with this
action never changes the currently promoted application version.

