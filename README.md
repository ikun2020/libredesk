<a href="https://zerodha.tech"><img src="https://zerodha.tech/static/images/github-badge.svg" align="right" alt="Zerodha Tech Badge" /></a>

<br>
<picture>
  <source
    media="(prefers-color-scheme: dark)"
    srcset="https://s3.ap-south-1.amazonaws.com/libredesk.io/libredesk_white.png?v=2">
  <source
    media="(prefers-color-scheme: light)"
    srcset="https://s3.ap-south-1.amazonaws.com/libredesk.io/libredesk_black.png?v=3">
  <img
    alt="LibreDesk"
    src="https://s3.ap-south-1.amazonaws.com/libredesk.io/libredesk_white.png?v=4"
    width="250">
</picture>

<br> Open source, self-hosted customer support software for email, live chat, and WhatsApp. Distributed as a single binary.

![image](https://libredesk.io/hero-dark.png?v=1)


Visit [libredesk.io](https://libredesk.io) for more info. Check out the [**live demo**](https://demo.libredesk.io/).

## Features

### Inbox and channels

- **Shared inbox:** Handle email, live chat, and WhatsApp conversations in one place.
- **Live chat:** Add a real-time chat widget to your website.
- **WhatsApp:** Connect a number through the Meta Cloud API.
- **Inbox organization:** Use teams, tags, custom statuses, custom attributes, snoozing, and search.

### Help center and AI

- **Help center:** Publish a searchable, multilingual knowledge base.
- **AI assistant:** Answer live chat questions using your knowledge base and hand conversations to an agent when needed.
- **Agent copilot:** Draft replies, summarize conversations, and find answers without leaving the inbox.

### Workflow and reporting

- **Automations:** Tag, assign, and route conversations using rules you define.
- **Macros:** Send saved replies and apply conversation actions in one step.
- **Auto assignment:** Distribute incoming conversations by agent capacity or your own criteria.
- **SLA management:** Set response targets and get notified about conversations at risk of breaching them.
- **CSAT and analytics:** Collect customer ratings and track response times, resolution rates, and agent activity.

### Administration and integrations

- **Permissions and SSO:** Create roles with per-action permissions and sign in through Google, Microsoft, or another OIDC provider.
- **Activity logs:** Review actions performed by agents and admins.
- **API and webhooks:** Connect LibreDesk to other systems and workflows.

See [libredesk.io](https://libredesk.io) for the full feature set, or try the [live demo](https://demo.libredesk.io/).


## Installation

### Railway (1-click deploy)

The fastest way to get a libredesk instance running. Railway provisions the app, Postgres, and Redis for you.

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/libredesk?referralCode=4gdm5b&utm_medium=integration&utm_source=template&utm_campaign=generic)

__________________

### Docker

#### GitHub Container Registry (this fork)

The [Docker image workflow](https://github.com/ikun2020/libredesk/actions/workflows/docker.yml)
builds the application and publishes a Linux `amd64` image to
`ghcr.io/ikun2020/libredesk`. It runs on pushes to `main`, `v*` tags, and manually
from **Actions → Docker image → Run workflow**. It uses the repository's
`GITHUB_TOKEN`; no Docker Hub credentials or extra secrets are required.

The `latest` and `main` tags track the default branch. Version tags retain their
name (for example, `v1.2.3`), and each build also has a `sha-<commit>` tag.
Publishing a version tag does not change `latest`.

```shell
docker pull ghcr.io/ikun2020/libredesk:latest
```

To use this image with the Compose file below, set the `app` service's `image` to
`ghcr.io/ikun2020/libredesk:latest`. GHCR packages are private on first publication;
for pulls without authentication, change the package's visibility to **Public**
in its GitHub package settings. Otherwise, authenticate to `ghcr.io` before pulling.

#### Upstream Docker Hub image

The latest image is available on DockerHub at [`libredesk/libredesk:latest`](https://hub.docker.com/r/libredesk/libredesk/tags?page=1&ordering=last_updated&name=latest)

```shell
# Download the compose file and sample config file in the current directory.
curl -LO https://github.com/abhinavxd/libredesk/raw/main/docker-compose.yml
curl -LO https://github.com/abhinavxd/libredesk/raw/main/config.sample.toml

# Copy the config.sample.toml to config.toml and edit it as needed.
cp config.sample.toml config.toml

# Run the services in the background.
docker compose up -d

# Setting System user password.
docker exec -it libredesk_app ./libredesk --set-system-user-password
```

Go to `http://localhost:9000` and login with username `System` and the password you set using the `--set-system-user-password` command.

See [installation docs](https://docs.libredesk.io/getting-started/installation)

__________________

### Binary
- Download the [latest release](https://github.com/abhinavxd/libredesk/releases) and extract the libredesk binary.
- Edit config.toml as needed.
- `./libredesk --install` to setup the Postgres DB.
- Run `./libredesk --set-system-user-password` to set the password for the System user.
- Run `./libredesk` and visit `http://localhost:9000` and login with email `System` and the password you set using the --set-system-user-password command.

See [installation docs](https://docs.libredesk.io/getting-started/installation)
__________________

## Keyword auto-replies

Fixed replies do not require an AI provider. In **Admin → Automations**, create
and enable a **Conversation update** rule with these settings:

| Setting | Value |
| --- | --- |
| Events | Incoming message |
| Match all conditions | Inbox equals your website's live chat inbox; Content contains `优惠券` |
| Action | Send reply: `123456` |

The Content condition on message events matches the text of the message that
triggered the event, including when it reopens a resolved or snoozed conversation.
Each matching customer message can trigger a reply. Select only **Incoming message**
for this rule so agent replies and status changes do not trigger it.

The first message of a new conversation uses **New conversation** rules instead.
To reply to both first and later messages, add a second rule of that type with
the same conditions and reply. Test with a new chat, a later matching message,
and a message that does not contain the keyword.

## Developers

- If you are interested in contributing, **please read [CONTRIBUTING.md](./CONTRIBUTING.md) first**.
- For local development and setup, refer to the [developer setup](https://docs.libredesk.io/contributing/developer-setup).
- For planned features and project direction, see [ROADMAP.md](./ROADMAP.md).

The backend is written in Go and the frontend is Vue.js 3 with Shadcn UI.



## Translators
You can help translate libredesk into your language on [Crowdin](https://crowdin.com/project/libredesk).  
