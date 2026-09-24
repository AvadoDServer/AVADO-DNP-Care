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
| `GET /api/status` | `{version, lastHeartbeat:{at, ok, error}, verdict, findings, subscribed, lastCheckAt, nextCheckAt, checking, sources}`. The AVADO Admin (`http://my.ava.do`, `http://*.my.ava.do`) may read it cross-origin (no credentials). |
| `POST /api/check-now` | Runs a check and heartbeat now (at most once a minute). Same-origin only. |

Every `/api` request must be addressed to the box (Host allow-list against DNS rebinding) and every
POST needs `X-Avado-Request: 1` from the package's own page (CSRF guard), like the Rocket Pool package.
Pages are served with a strict CSP. The service runs as the unprivileged `node` user.

When the backend refuses a heartbeat's timestamp (401 with `serverTime`), the heartbeat is re-signed
once with the backend's clock. If the DAPPMANAGER refuses that time too, the status page says the box's
clock is wrong. A DAPPMANAGER without the care signing actions (10.0.47 and older) is asked again only
after it changes version, so the Admin's activity log does not fill with errors.

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
`health/clients.js`, `health/prometheus.js`, `health/rules/*.js` and `services/store/updates.js`
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

## Development

```sh
cd build/service
yarn install
yarn lint && yarn test   # Node 22
yarn build
```

The image build (`docker compose build`, linux/amd64) runs the type check and the tests; a red suite
fails the build.
