---
name: portly
description: Set up and use portly for named local dev server URLs (e.g. https://myapp.localhost instead of http://localhost:3000). Use when integrating portly into a project, configuring dev server names, setting up the local proxy, working with .localhost domains, or troubleshooting port/proxy issues.
---

# Portly

Replace port numbers with stable, named .localhost URLs. For humans and agents.

## Why portly

- **Port conflicts**: `EADDRINUSE` when two projects default to the same port
- **Memorizing ports**: which app is on 3001 vs 8080?
- **Refreshing shows the wrong app**: stop one server, start another on the same port, stale tab shows wrong content
- **Monorepo multiplier**: every problem scales with each service in the repo
- **Agents test the wrong port**: AI agents guess or hardcode the wrong port
- **Cookie/storage clashes**: cookies on `localhost` bleed across apps; localStorage lost when ports shift
- **Hardcoded ports in config**: CORS allowlists, OAuth redirects, `.env` files break when ports change
- **Sharing URLs with teammates**: "what port is that on?" becomes a Slack question
- **Browser history is useless**: `localhost:3000` history is a mix of unrelated projects

## Installation

Install globally (recommended) or as a project dev dependency. Do NOT use `npx` or `pnpm dlx` for one-off execution.

```bash
# Global (available everywhere)
npm install -g @guthyerrz/portly

# Or per-project dev dependency
npm install -D @guthyerrz/portly
```

When installed per-project, invoke via package.json scripts or `npx @guthyerrz/portly` (since the package is local, npx will not download anything).

## Quick Start

```bash
# Install globally (or add -D to a project)
npm install -g @guthyerrz/portly

# Run your app (auto-starts the HTTPS proxy on port 443)
portly run next dev
# -> https://<project>.localhost

# Or with an explicit name
portly myapp next dev
# -> https://myapp.localhost
```

The proxy auto-starts when you run an app. You can also start it explicitly with `portly proxy start`. Auto-start reuses the configuration (port, TLS, TLD) from the most recent proxy run, so a restart or reboot does not silently revert to defaults. Explicit env vars always take priority.

In non-interactive environments (no TTY, or `CI=1`), portly exits with a descriptive error instead of prompting. Task runners like turborepo should pre-start the proxy.

## Integration Patterns

### Zero-config (recommended)

Bare `portly` works out of the box. It runs the `"dev"` script from `package.json` through the proxy, inferring the app name from the package name, git root, or directory:

```bash
portly        # -> runs "dev" script, https://<project>.localhost
pnpm dev        # -> works without portly, plain "next dev"
```

Use an optional `portly.json` to override defaults (name, script, port):

```json
{ "name": "myapp" }
```

```bash
portly        # -> runs "dev" script, https://myapp.localhost
```

### Monorepo

One `portly.json` at the repo root. Portly discovers packages from `pnpm-workspace.yaml`, or the `"workspaces"` field in `package.json` (npm, yarn, bun):

```json
{
  "apps": {
    "apps/web": { "name": "myapp" },
    "apps/api": { "name": "api.myapp" }
  }
}
```

```bash
portly                  # from repo root: start all packages with a "dev" script
cd apps/web && portly   # start just one package
portly --script start   # run "start" instead of "dev"
```

The `apps` map is optional and only provides name overrides. Unlisted packages auto-discover with inferred names.

Without an `apps` map, hostnames follow `<package>.<project>.localhost`. The project name comes from the most common npm scope (e.g. `@myorg/web` and `@myorg/api` produce `myorg`), falling back to the workspace root directory name. If a package's short name matches the project name, it uses the bare `<project>.localhost`.

### Turborepo

For turborepo projects, use portly as the `dev` script with the real command in a separate script:

```json
{
  "scripts": { "dev": "portly", "dev:app": "next dev" },
  "portly": { "name": "myapp", "script": "dev:app" }
}
```

`pnpm dev` runs turbo, which runs `portly` in each package. Portly detects the package manager and runs `pnpm run dev:app` through the proxy.

### package.json scripts

You can still use portly directly in scripts:

```json
{
  "scripts": {
    "dev": "portly run next dev"
  }
}
```

The proxy auto-starts when you run an app. Or start it explicitly: `portly proxy start`.

### Multi-app setups with subdomains

```bash
portly myapp next dev          # https://myapp.localhost
portly api.myapp pnpm start    # https://api.myapp.localhost
portly docs.myapp next dev     # https://docs.myapp.localhost
```

By default, only explicitly registered subdomains are routed (strict mode). Start the proxy with `--wildcard` to allow any subdomain of a registered route to fall back to that app (e.g. `tenant1.myapp.localhost` routes to the `myapp` app). Exact matches always take priority over wildcards.

### Git worktrees

`portly run` automatically detects git worktrees. In a linked worktree, the branch name is prepended as a subdomain prefix so each worktree gets a unique URL:

```bash
# Main worktree (no prefix)
portly run next dev   # -> https://myapp.localhost

# Linked worktree on branch "fix-ui"
portly run next dev   # -> https://fix-ui.myapp.localhost
```

No config changes needed. Put `portly run` in `package.json` once and it works in all worktrees.

### Bypassing portly

Set `PORTLY=0` to run the command directly without the proxy:

```bash
PORTLY=0 pnpm dev   # Bypasses proxy, uses default port
```

## How It Works

1. `portly proxy start` starts an HTTPS reverse proxy on port 443 as a background daemon. Auto-elevates with sudo on macOS/Linux; falls back to port 1355 if sudo is unavailable. Use `--no-tls` for plain HTTP on port 80. Configurable with `-p` / `--port` or the `PORTLY_PORT` env var. The proxy also auto-starts when you run an app.
2. `portly <name> <cmd>` assigns a random free port (4000-4999) via the `PORT` env var and registers the app with the proxy
3. The browser hits `https://<name>.localhost`; the proxy forwards to the app's assigned port

`.localhost` domains resolve to `127.0.0.1` natively in Chrome, Firefox, and Edge. Safari relies on the system DNS resolver, which may not handle `.localhost` subdomains on all configurations. Run `portly hosts sync` to add entries to `/etc/hosts` if needed.

Most frameworks (Next.js, Express, Nuxt, etc.) respect the `PORT` env var automatically. For frameworks that ignore `PORT` (Vite, VitePlus, Astro, React Router, Angular, Expo, React Native), portly auto-injects the correct `--port` flag and, when needed, a matching `--host` CLI flag.

### State directory

Portly stores its state (routes, PID file, port file) in `~/.portly`. Override with the `PORTLY_STATE_DIR` environment variable.

### Environment variables

| Variable            | Description                                                                 |
| ------------------- | --------------------------------------------------------------------------- |
| `PORTLY_PORT`       | Override the default proxy port (default: 443 with HTTPS, 80 without)       |
| `PORTLY_APP_PORT`   | Use a fixed port for the app (skip auto-assignment)                         |
| `PORTLY_HTTPS`      | HTTPS on by default; set to `0` to disable (same as `--no-tls`)             |
| `PORTLY_LAN`        | Set to `1` to always enable LAN mode (auto-detects LAN IP)                  |
| `PORTLY_LAN_IP`     | Pin a specific LAN IP for LAN mode                                          |
| `PORTLY_TLD`        | Use a custom TLD instead of localhost (e.g. test)                           |
| `PORTLY_WILDCARD`   | Set to `1` to allow unregistered subdomains to fall back to parent          |
| `PORTLY_SYNC_HOSTS` | Set to `0` to disable auto-sync of /etc/hosts (on by default)               |
| `PORTLY_TAILSCALE`  | Set to `1` to share apps on your Tailscale network (same as `--tailscale`)  |
| `PORTLY_FUNNEL`     | Set to `1` to share apps publicly via Tailscale Funnel (same as `--funnel`) |
| `PORTLY_NGROK`      | Set to `1` to share apps publicly via ngrok (same as `--ngrok`)             |
| `PORTLY_STATE_DIR`  | Override the state directory                                                |
| `PORTLY=0`          | Bypass the proxy, run the command directly                                  |

### HTTP/2 + HTTPS

HTTPS with HTTP/2 is enabled by default (faster page loads for dev servers with many files). First run generates a local CA and adds it to the system trust store. After that, no prompts and no browser warnings.

```bash
portly proxy start --cert ./c.pem --key ./k.pem  # Use custom certs
portly proxy start --no-tls                       # Disable HTTPS (plain HTTP)
portly trust                                      # Add CA to trust store later
```

On Linux, `portly trust` supports Debian/Ubuntu, Arch, Fedora/RHEL/CentOS, and openSUSE (via `update-ca-certificates` or `update-ca-trust`). On Windows, it uses `certutil` to add the CA to the system trust store.

### LAN mode

```bash
portly proxy start --lan
portly proxy start --lan --https
portly proxy start --lan --ip 192.168.1.42
```

`--lan` advertises `<name>.local` hostnames over mDNS so any device on the same Wi-Fi can reach your apps. Portly auto-detects your LAN IP and follows network changes automatically, but you can pin a specific address with `--ip <address>` or the `PORTLY_LAN_IP` environment variable. Set `PORTLY_LAN=1` to default to LAN mode every time the proxy starts.

Portly remembers LAN mode via `proxy.lan`, so if you stop a LAN proxy and start again, it stays in LAN mode. All proxy settings (port, TLS, TLD, LAN) are persisted and reused on auto-start unless overridden by explicit flags or env vars. Use `PORTLY_LAN=0` for one start to switch back to `.localhost` mode. If a proxy is already running with different explicit LAN/TLS/TLD settings, portly warns and asks you to stop it first.

LAN mode depends on the system mDNS helpers that portly launches: macOS includes `dns-sd`, while Linux uses `avahi-publish-address` from `avahi-utils` (install via `sudo apt install avahi-utils` or your distro’s tooling).

- **Next.js**: add your `.local` hostnames to `allowedDevOrigins`:

  ```js
  // next.config.js
  module.exports = {
    allowedDevOrigins: ["myapp.local", "*.myapp.local"],
  };
  ```

- **Expo / React Native**: portly always injects `--port`. React Native also gets `--host 127.0.0.1`. Expo gets `--host localhost` outside LAN mode, but in LAN mode portly leaves Metro on its default LAN host behavior instead of forcing `--host` or `HOST`.

### Tailscale sharing

Share dev servers with teammates on your Tailscale network using `--tailscale`, or expose to the public internet with `--funnel`:

```bash
portly myapp --tailscale next dev
# -> https://myapp.localhost           (local)
# -> https://devbox.yourteam.ts.net    (tailnet)

portly myapp --funnel next dev
# -> https://myapp.localhost           (local)
# -> https://devbox.yourteam.ts.net    (public internet)
```

Tailscale HTTPS certificates must be enabled before `--tailscale` or `--funnel` can register HTTPS URLs. Funnel must also be enabled for the tailnet and node before `--funnel` can register the public URL. If either setting is missing, portly exits before starting the child process.

Each `--tailscale` app is root-mounted on its own Tailscale HTTPS port (443, then 8443, 8444, etc.) so no framework `basePath` configuration is needed. Set `PORTLY_TAILSCALE=1` to share every app by default. `portly list` shows both local and tailnet URLs. Tailscale serve registrations are cleaned up when the app exits. Requires `tailscale` CLI installed and connected, with Tailscale HTTPS certificates enabled.

### ngrok sharing

Expose a dev server to the public internet with ngrok using `--ngrok`:

```bash
portly myapp --ngrok next dev
# -> https://myapp.localhost           (local)
# -> https://abc123.ngrok.app          (public internet)
```

Set `PORTLY_NGROK=1` to enable ngrok by default when portly runs an app. `portly list` shows both local and ngrok URLs. The ngrok tunnel is cleaned up when the app exits. Requires the `ngrok` CLI to be installed and authenticated with `ngrok config add-authtoken <token>`.

## OS startup service

Use the service command when users want the proxy to start automatically after reboot:

```bash
portly service install
portly service install --lan
portly service install --wildcard
PORTLY_STATE_DIR=~/.portly-lan PORTLY_LAN=1 portly service install
portly service status
portly service uninstall
```

The service uses portly defaults unless install options or `PORTLY_*` environment variables are provided: HTTPS on port 443 with `.localhost` names. `service install` accepts proxy options including `--port`, `--no-tls`, `--lan`, `--ip`, `--tld`, `--wildcard`, `--cert`, and `--key`. Use `--state-dir <path>` or `PORTLY_STATE_DIR=<path>` to choose where service state and logs are written.

The chosen service configuration is written into launchd, systemd, or Task Scheduler and reused after reboot. `portly service status` reports the installed port, HTTPS mode, TLD, LAN mode, wildcard mode, and state directory. macOS and Linux install a root-owned service so port 443 can bind at boot. Windows installs a Task Scheduler startup task that runs as SYSTEM. Installation and removal may require administrator privileges. `portly clean` automatically removes the service.

## CLI Reference

| Command                              | Description                                                    |
| ------------------------------------ | -------------------------------------------------------------- |
| `portly`                             | Run dev script through proxy                                   |
| `portly`                             | From monorepo root: run all workspace packages                 |
| `portly --script <name>`             | Run a specific package.json script (default: dev)              |
| `portly run [cmd] [args...]`         | Infer name from project, run through proxy (auto-starts)       |
| `portly run --name <name> <cmd>`     | Override inferred base name (worktree prefix still applies)    |
| `portly <name> <cmd> [args...]`      | Run app at `https://<name>.localhost` (auto-starts proxy)      |
| `portly get <name>`                  | Print URL for a service (for cross-service wiring)             |
| `portly get <name> --no-worktree`    | Print URL without worktree prefix                              |
| `portly list`                        | Show active routes                                             |
| `portly trust`                       | Add local CA to system trust store (for HTTPS)                 |
| `portly clean`                       | Remove state, CA trust entry, and /etc/hosts block             |
| `portly prune`                       | Kill orphaned dev servers from crashed sessions                |
| `portly prune --force`               | Kill orphans with SIGKILL instead of SIGTERM                   |
| `portly proxy start`                 | Start HTTPS proxy as a daemon (port 443, auto-elevates)        |
| `portly proxy start --no-tls`        | Start without HTTPS (plain HTTP on port 80)                    |
| `portly proxy start --lan`           | Start in LAN mode (mDNS `.local`, auto-follows LAN IP changes) |
| `portly proxy start -p <number>`     | Start the proxy on a custom port                               |
| `portly proxy start --tld test`      | Use .test instead of .localhost                                |
| `portly proxy start --foreground`    | Start the proxy in foreground (for debugging)                  |
| `portly proxy start --wildcard`      | Allow unregistered subdomains to fall back to parent route     |
| `portly proxy stop`                  | Stop the proxy                                                 |
| `portly service install`             | Start the HTTPS proxy when the OS starts                       |
| `portly service install --lan`       | Start the service in LAN mode                                  |
| `portly service install --wildcard`  | Persist wildcard routing in the startup service                |
| `portly service status`              | Show service and proxy status                                  |
| `portly service uninstall`           | Remove the startup service                                     |
| `portly alias <name> <port>`         | Register a static route (e.g. for Docker containers)           |
| `portly alias <name> <port> --force` | Overwrite an existing route                                    |
| `portly alias --remove <name>`       | Remove a static route                                          |
| `portly hosts sync`                  | Add routes to /etc/hosts (fixes Safari)                        |
| `portly hosts clean`                 | Remove portly entries from /etc/hosts                          |
| `portly <name> --app-port <n> <cmd>` | Use a fixed port for the app instead of auto-assignment        |
| `portly <name> --tailscale <cmd>`    | Share the app on your Tailscale network (tailnet)              |
| `portly <name> --funnel <cmd>`       | Share the app publicly via Tailscale Funnel                    |
| `portly <name> --ngrok <cmd>`        | Share the app publicly via ngrok                               |
| `portly <name> --force <cmd>`        | Kill the existing process and take over its route              |
| `portly --name <name> <cmd>`         | Force `<name>` as app name (bypasses subcommand dispatch)      |
| `portly <name> -- <cmd> [args...]`   | Stop flag parsing; everything after `--` is passed to child    |
| `portly --help` / `-h`               | Show help                                                      |
| `portly run --help`                  | Show help for a subcommand (also: alias, hosts, clean)         |
| `portly --version` / `-v`            | Show version                                                   |

**Reserved names:** `run`, `get`, `alias`, `hosts`, `list`, `trust`, `clean`, `prune`, `proxy`, and `service` are subcommands and cannot be used as app names directly. Use `portly run <cmd>` to infer the name, or `portly --name <name> <cmd>` to force any name including reserved ones.

## portly.json

Optional config file. Portly looks for it in the current directory.

| Field     | Type    | Default                    | Description                                              |
| --------- | ------- | -------------------------- | -------------------------------------------------------- |
| `name`    | string  | inferred from package.json | Base app name (worktree prefix still applies)            |
| `script`  | string  | `"dev"`                    | Name of a package.json script to run                     |
| `appPort` | number  | auto-assigned              | Fixed port for the child process                         |
| `proxy`   | boolean | auto-detected              | Whether to route through the proxy (`false` for tasks)   |
| `apps`    | object  |                            | Overrides for workspace packages, keyed by relative path |
| `turbo`   | boolean | `true`                     | Set `false` to use direct spawning instead of turborepo  |

Each `apps` entry has the same shape (`name`, `script`, `appPort`, `proxy`). When `apps` is present, top-level fields apply only in single-app mode.

### package.json "portly" key

Instead of a separate `portly.json`, you can add a `"portly"` key to your `package.json`. A string value is shorthand for setting the name:

```json
{ "portly": "myapp" }
```

An object supports all per-app fields (`name`, `script`, `appPort`, `proxy`):

```json
{ "portly": { "name": "myapp", "script": "dev:app" } }
```

Precedence (closest wins): CLI flags > package.json `"portly"` key > portly.json app entry > defaults.

## Troubleshooting

### Proxy not running

The proxy auto-starts when you run an app with `portly <name> <cmd>`. If it doesn't start (e.g. port conflict), start it manually:

```bash
portly proxy start
```

### Port already in use

Another process is bound to the proxy port. Either stop it first, or use a different port:

```bash
portly proxy start -p 8080
```

### Framework not respecting PORT

Portly auto-injects the right `--port` flag and, when needed, a matching `--host` flag for frameworks that ignore the `PORT` env var: **Vite**, **VitePlus** (`vp`), **Astro**, **React Router**, **Angular**, **Expo**, and **React Native**. SvelteKit uses Vite internally and is handled automatically.

For other frameworks that don't read `PORT`, pass the port manually:

- **Webpack Dev Server**: use `--port $PORT`
- **Custom servers**: read `process.env.PORT` and listen on it

### Permission errors

The default ports (80 for HTTP, 443 for HTTPS) require `sudo` on macOS and Linux. Portly auto-elevates with sudo when needed. If sudo is unavailable, it falls back to port 1355 (no sudo needed). On Windows, no elevation is required.

```bash
portly proxy start --https           # Auto-elevates with sudo for port 443
portly proxy start -p 1355 --https   # No sudo needed (URLs include :1355)
portly proxy stop                    # Stop (use sudo if started with sudo)
```

### Safari can't find .localhost URLs

Safari relies on the system DNS resolver for `.localhost` subdomains, which may not resolve them on all macOS configurations. Chrome, Firefox, and Edge have built-in handling.

Fix:

```bash
portly hosts sync    # Adds current routes to /etc/hosts
portly hosts clean   # Remove entries later
```

Auto-syncs `/etc/hosts` for route hostnames by default. Set `PORTLY_SYNC_HOSTS=0` to disable.

### Browser shows certificate warning with --https

The local CA may not be trusted yet. Run:

```bash
portly trust
```

This adds the portly local CA to your system trust store. After that, restart the browser.

### Remove portly from the machine

```bash
portly clean
```

Stops the proxy if needed, removes the portly CA from the trust store (when portly added it), deletes known files under state directories, and removes the portly `/etc/hosts` block. May require `sudo` on macOS/Linux.

### Proxy loop (508 Loop Detected)

If your dev server proxies requests to another portly app (e.g. Vite proxying `/api` to `api.myapp.localhost`), the proxy must rewrite the `Host` header. Without this, portly routes the request back to the original app, creating an infinite loop.

Fix: set `changeOrigin: true` in the proxy config (Vite, webpack-dev-server, etc.):

```ts
// vite.config.ts
proxy: {
  "/api": {
    target: "https://api.myapp.localhost",
    changeOrigin: true,
    ws: true,
  },
}
```

Portly automatically sets `NODE_EXTRA_CA_CERTS` in child processes so Node.js trusts the portly CA. If you run a separate Node.js process outside portly, point it at the CA manually: `NODE_EXTRA_CA_CERTS=~/.portly/ca.pem`. Alternatively, use `--no-tls` for plain HTTP.

### Tailscale not working

If `--tailscale` or `--funnel` fails:

```bash
tailscale status     # Check if connected
tailscale up         # Connect to your tailnet
```

Requires the Tailscale CLI to be installed (https://tailscale.com/download) and on PATH.

### ngrok not working

If `--ngrok` fails:

```bash
ngrok version                         # Check if installed
ngrok config add-authtoken <token>    # Configure authentication
```

Requires the ngrok CLI to be installed (https://ngrok.com/download) and on PATH.

### Requirements

- Node.js 24+
- macOS, Linux, or Windows
- `openssl` (for `--https` cert generation; ships with macOS and most Linux distributions; on Windows, install via `winget install -e --id ShiningLight.OpenSSL.Dev` or use the copy bundled with Git for Windows)
- `tailscale` CLI (optional, for `--tailscale` and `--funnel`)
- `ngrok` CLI (optional, for `--ngrok`)
