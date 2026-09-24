# AVADO Care

`care.avado.dnp.dappnode.eth`: the on-box half of Priority Care.

Every 10 minutes the package:

1. builds the same health snapshot the AVADO Admin builds (DAPPMANAGER `listPackages`, `getStats`,
   `getParams`, the `chainData` topic, the store update check, and Prometheus when the monitoring
   package runs),
2. runs the Admin's own health rules on it (vendored, see below),
3. sends a heartbeat signed with the box identity key to the Priority Care backend
   (`$BACKEND_URL/api/care/heartbeat`). The DAPPMANAGER signs it (`signPrioritySupportRequest`,
   action `care-heartbeat`); the key never leaves the DAPPMANAGER.

The heartbeat carries only: package names and versions, disk use in %, the verdict, and the ids and
titles of critical and warning findings. Never keys, wallet, IP addresses, peers or validator data.
The backend keeps it only for Priority Care subscribers.

A status page at http://care.my.ava.do shows "AVADO is watching your box", the last check, open
problems, and a "Check now" button.

## API (port 80, inside the AVADO network only; no host ports)

| Route | What |
|---|---|
| `GET /api/status` | `{version, lastHeartbeat:{at, ok, error}, heartbeatIssue, verdict, findings, subscribed, emailVerified, lastCheckAt, nextCheckAt, checking, sources, notice}`. The AVADO Admin (exactly `http(s)://my.ava.do`) may read it cross-origin (no credentials). |
| `POST /api/check-now` | Runs a check and heartbeat now (at most once a minute); answers within about a minute, with `checking: true` if it is still running. Same-origin only. |

Every `/api` request must be addressed to the box (Host allow-list against DNS rebinding) and every
POST needs `X-Avado-Request: 1` from the package's own page (CSRF guard), like the Rocket Pool package.
Pages are served with a strict CSP. The service runs as the unprivileged `node` user; the node binary
has the file capability `cap_net_bind_service`, so port 80 works on every Docker version.

## Load and noise limits

- Every DAPPMANAGER call carries `dontLogError: true`, so a failed call never lands in the Admin's
  activity log.
- `listPackages` (which runs `docker system df -v`) is called at start and then at most once an hour;
  disk use comes from `getStats` on every check. The store catalogue is checked hourly.
- Fee recipients (for the Admin's `fee-recipient-missing` rule) are read hourly from each running
  validator client's `:9999/keymanager` route (the key list plus one request per key, at most 64
  keys). A zero fee recipient counts only if the client's beacon node has that validator active or
  exited (one batched lookup); pending or unknown keys never count. When no running client can be
  read, the input fails (6 h back-off after 3 failures, findings carried over for up to 24 h).
  Only counts are kept; no pubkey or address leaves the box. (The Admin cannot read these clients
  from the browser, their CORS lists leave out http://my.ava.do, so this finding comes from Care.)
- Pending updates: the first time each one was seen is kept in `state.json`, for the Admin's
  `update-blocked` rule (48 h).
- chainData: the package first listens ~6 s for a push (an open Admin tab causes one) and only then
  asks the DAPPMANAGER to publish.
- An input whose call keeps failing (3 answered errors in a row) is left alone for 6 hours. While an
  input fails, its previous findings are kept for up to 24 h after its last good read, so a flaky
  source never reads as "cleared" and re-alerts. Each input's last good read is kept in `state.json`,
  so the 24 h limit holds across restarts.
- A package list that could not be refreshed for more than 24 h is not used any more: the check
  reports `checking` with no findings, `sources.packages` is `stale`, the status page says so in
  plain words, and the box still sends a `checking` heartbeat while the DAPPMANAGER answers.
- When the backend refuses a heartbeat's timestamp (401 with `serverTime`), the heartbeat is re-signed
  once with the backend's clock, but only if that is within 9 minutes of the box clock. Otherwise (or if
  the DAPPMANAGER refuses it) the status says the box's clock is wrong and signing waits 6 hours.
- A DAPPMANAGER without the care signing actions (10.0.47 and older) is asked again only after it
  changes version, and the checks run hourly meanwhile.
- Every interval gets ±60 s of jitter.

## Volume

`care:/data` holds `state.json`: the last check (verdict, findings) and the last heartbeat result, so
the status page is right after a restart. Nothing secret is stored.

## Settings

| Env | Default |
|---|---|
| `BACKEND_URL` | `https://priorityapi.ava.do` |

Also for tests: `WAMP_URL`, `STORE_RPC_URL`, `IPFS_GATEWAY`, `IPFS_API`, `INTERVAL_MS`, `FIRST_RUN_DELAY_MS`,
`CHECK_NOW_COOLDOWN_MS`, `EXTRA_ALLOWED_HOSTNAMES` (see `build/service/src/config.ts`).

## Health rules (vendored from the Admin)

`build/service/vendor/admin` holds byte-for-byte copies of the Admin's `health/engine.js`,
`health/clients.js`, `health/prometheus.js`, `health/feeRecipients.js`, `health/updateAges.js`,
`health/rules/*.js` and `services/store/updates.js`
(not `fixActions.js`). `vendor/admin/VENDORED.json` records their sha256 and the Admin commit.
`scripts/vendor-build.mjs` only rewrites their import paths for Node when building.

`test/vendor-sync.test.ts` fails when a copy was edited here, and, when a DNP_ADMIN checkout is found
(`$ADMIN_SRC` or `../DNP_ADMIN` next to this repo), when the Admin's files changed or it has a new
rule file. To update:

```sh
cd build/service
yarn vendor:sync   # ADMIN_SRC=/path/to/DNP_ADMIN/build/src/src if needed
yarn test
```

Release checklist: the image build cannot see the Admin, so before each release run the sync check
against the Admin that is being released:
`git clone --depth 1 https://github.com/AvadoDServer/DNP_ADMIN /tmp/admin && ADMIN_SRC=/tmp/admin/build/src/src yarn test`.

## Development

```sh
cd build/service
yarn install
yarn lint && yarn test   # Node 22
yarn build
```

The image build (`docker compose build`, linux/amd64) runs the type check and the tests; a red suite
fails the build.
