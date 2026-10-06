# spec.md

## Overview
A lightweight, mobile-friendly web service to monitor, update, and manage containerized applications directly on a host machine from a private network. It scans a defined local directory for Docker Compose projects, provides quick operational visibility, and exposes one-click actions to pull remote source updates and trigger container rebuilds.

---

## Tech Stack
* **Backend:** Node.js (Express).
* **Frontend:** Server-rendered or vanilla HTML/CSS/JS, no build step required. Mobile-first responsive layout.
* **Docker Access:** The manager container runs the `docker` CLI (with the Compose v2 plugin) and `git` CLI as subprocesses, talking to the host engine over a bind-mounted `/var/run/docker.sock`. (This grants root-equivalent host access by design — see Security below.)
* **Live updates:** Server-Sent Events (SSE) for streaming pull/rebuild output to the browser. No WebSocket needed (one-directional, server → client).
* **State:** Stateless. All status is queried live from Docker/git on each request; no database. An in-memory map tracks in-flight operations per project (see Concurrency).

---

## Environment & Access Privileges
* **Root Project Location:** `/docker` (bind-mounted read/write into the manager container).
* **Discovery Rule:** Any immediate subdirectory containing a compose file — `docker-compose.yml`, `docker-compose.yaml`, `compose.yml`, or `compose.yaml` — is treated as a managed project (`/docker/*/<compose-file>`), regardless of whether its containers are currently running. First match wins if a directory has more than one of these names.
* **Git Requirement:** A project directory is treated as "git-managed" only if it contains a `.git` folder with at least one configured remote. Projects without one are still discovered and shown (so rebuild/status still works), but the git fields are blank and the "Update Source" action is disabled with a tooltip explaining why.
* **Host Access Requirements:** The service container must be granted host privileges necessary to inspect and control the host Docker engine (`docker.sock` mount, equivalent to root on the host). Only run this on a trusted host.
* **SSH Git Remotes:** Projects whose remote is an SSH URL (`git@host:...`) need the container to have a usable SSH key + known host entries. The container's image includes `openssh-client` for this, and bind-mounts `/root/.ssh` from the host read-only so it reuses whatever already works for manual `git pull` as root — same trust tradeoff as the docker.sock mount: the container can use that key for anything, not only git.
* **Network Isolation:** Service ports are exposed exclusively on the local/private network.
* **Authentication:** Out of scope for this app. It assumes a reverse proxy or network layer (e.g. Tailscale, Caddy basic-auth, Authelia, WireGuard) in front of it handles access control. The app must not bind to anything beyond the private network interface and should log a startup warning if no auth-related env var/header is detected (best-effort hint, not enforcement).

---

## Deploying the Manager Itself
The manager is installed the same way it installs everything else: as a git checkout living directly under `/docker`, built from source with `docker compose up -d --build`.

1. Push this repository to a git remote reachable from the Docker host — GitHub/GitLab, or a plain bare repo on the host itself (`git init --bare` somewhere outside `/docker`, no external service required).
2. On the host: `git clone <remote> /docker/docker-local-manager`.
3. `cd /docker/docker-local-manager && docker compose up -d --build`.

Because this directory then satisfies the Discovery Rule above, **the manager will list and manage itself** on its own dashboard — "Update Source" pulls its own repo, "Rebuild" rebuilds its own image. This is intentional, not a bug to route around, but it has one sharp edge:

* **Self-rebuild drops the request mid-flight.** Rebuilding the manager's own project recreates the very container handling that HTTP/SSE request, so the log stream cuts off abruptly instead of reporting a clean "success." The rebuild itself still completes normally — refresh the page once the new container is up to confirm.

---

## System Capabilities & Data Requirements

### 1. Project Discovery & Status Dashboard
The mobile-friendly interface displays an overview of all detected projects under `/docker`. Each project entry presents:

* **Project Identifier:** Derived from the project directory name under `/docker`.
* **Git Repository Context** (blank/disabled if not git-managed):
  * Active Git commit hash (short format) and message.
  * Dirty working tree indicator (uncommitted changes present).
  * HEAD state: attached to branch `<name>`, or **detached at `<hash>`** (see Rollback).
  * Ahead/behind counts relative to the remote tracking branch — **only populated after an explicit "Check for Updates" fetch** (see below); shown as "last checked `<time>`" alongside the counts since it goes stale as soon as the remote moves.
* **Container Runtime Context:**
  * One row per service defined in the compose file: image name/tag, running state (running / exited / restarting / not created), and uptime if running.
  * Project-level rollup state: **Up** (all services running), **Partial** (some running), **Down** (none running).
  * Last image build timestamp per service (queried from Docker image metadata, `Created` field).
* **Refresh:** Dashboard polls *local* status (git HEAD/dirty state, container state) on a fixed interval (default 15s, configurable via env var) plus manual pull-to-refresh. This polling never touches the network (no implicit fetch) — ahead/behind is only ever refreshed by the explicit action below.

### 2. Operational Actions
Each project entry provides actionable controls to manage deployment states:

* **Check for Updates (`git fetch`):** Explicit, on-demand only — never run automatically or on a timer. Updates the ahead/behind counts shown on the dashboard. This is the *only* thing that calls `git fetch`; nothing else implicitly fetches.
* **Update Source (`git pull`):** Fetches and merges the latest commits from the configured remote for that project folder. (A pull makes a prior fetch's ahead/behind numbers moot — they're recomputed stale again until the next explicit check.)
  * Disabled if the working tree is dirty, HEAD is detached, or the project isn't git-managed; the UI explains why instead of attempting a pull that will fail.
  * Merge conflicts or non-fast-forward failures are surfaced verbatim in the action log, not auto-resolved.
* **Rebuild & Restart (`docker compose up -d --build`):** Rebuilds necessary images and recreates/restarts the project's containers in detached mode, run from the project directory so relative paths/env files resolve correctly.
  * **Optional "pull first" toggle:** the rebuild action accepts an optional pull-before-build flag. When set, the server runs `git pull` and only proceeds to the build step if the pull succeeds (same dirty/detached guards as standalone pull apply); on failure the rebuild is aborted and reported, nothing is built.
* **Rollback (`git checkout <hash>` + rebuild):** Lets the user re-deploy a previous commit without needing any separate history store — git's own commit log on disk is already the full history, so we just read it instead of tracking a parallel copy:
  * The UI offers a dropdown of recent commits for the project (hash, message, date), fetched live via `git log`.
  * Picking one checks out that commit (requires a clean working tree) and puts the repo in **detached HEAD**; the dashboard reflects this immediately. Rollback can optionally chain straight into a rebuild, same as the pull-first toggle.
  * A **"Return to latest"** action is shown whenever HEAD is detached: runs `git checkout <branch>` against the remote's default branch (resolved via `git symbolic-ref refs/remotes/origin/HEAD`, so it works correctly even while detached) to reattach, after which normal pull/fetch resume working.
  * **Known limitation:** rollback only reaches as far back as the local clone's history. A shallow clone (`--depth`) won't have older commits available; the spec assumes full clones.
* **Concurrency control:** Only one operation (fetch, pull, rebuild, or checkout) may run per project at a time. A second request for the same project while one is in-flight is rejected (HTTP 409) and the UI disables that project's buttons for the duration, driven by the SSE stream's completion event. Operations on different projects may run concurrently.
* **Timeouts:** Each operation has a server-side timeout (default 10 minutes, configurable) after which it's killed and reported as failed.

### 3. Action Status Feed
* While an operation runs, its stdout/stderr is streamed line-by-line to the browser over SSE and rendered in a scrollable log panel under that project's card.
* On completion, a clear success/error banner is shown with the exit code; the log remains visible/collapsible until dismissed or the next action starts.
* If the browser disconnects/reconnects mid-operation, re-subscribing to that project's stream replays buffered output so far (buffer kept in the in-memory operation record).

---

## API Surface (for implementation reference)
* `GET /api/projects` — list all discovered projects with current *local* git + container status (no network calls).
* `GET /api/projects/:name` — status for a single project.
* `POST /api/projects/:name/fetch` — run `git fetch`; returns updated ahead/behind counts. `202` + operation id, or `409` if one is already running.
* `POST /api/projects/:name/pull` — start a git pull; `202` + operation id, or `409`.
* `POST /api/projects/:name/rebuild` — body `{ pull?: boolean }`; start `docker compose up -d --build`, optionally pulling first. Same status codes.
* `GET /api/projects/:name/history` — recent commits from local `git log` (hash, message, date), default last 20.
* `POST /api/projects/:name/checkout` — body `{ hash: string, rebuild?: boolean }`; check out a prior commit (detaches HEAD), optionally chaining into a rebuild.
* `POST /api/projects/:name/reattach` — check out the remote's default branch to leave detached HEAD state.
* `GET /api/projects/:name/stream` — SSE stream of the current/most recent operation's output and status.

---

## User Interface Requirements
* **Responsive / Mobile-First Layout:** Optimized for touch interactions and narrow viewports (smartphones); large tap targets for Pull/Rebuild.
* **Action Status Feeds:** Clear visual indication when a pull or rebuild operation is in progress (spinner/disabled buttons), followed by success or error output in an expandable log panel.
* **Disabled-state affordance:** Buttons disabled for non-git projects, dirty working trees, or in-flight operations must show *why* (tooltip/inline text), not just appear greyed out.

---

## Non-Goals (explicitly out of scope for v1)
* User accounts, roles, or per-project permissions.
* Editing compose files, env files, or project source from the UI.
* Log viewing for *running* containers (only action-triggered command output).
* Scheduling/automatic pulls or rebuilds (manual trigger only).
* Multi-host support (single Docker host only).

---

## Open Questions for Later Iterations
* Should the history dropdown cap at a fixed count (e.g. last 20 commits) or be paginated for very long-lived projects?
* Should "Return to latest" also offer a rebuild chain, same as checkout does?
