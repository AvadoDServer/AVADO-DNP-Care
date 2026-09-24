// Client metrics from the monitoring package. Queries are tried against the
// Admin's own same-origin nginx proxy first (build/nginx.conf `/metrics-api/`,
// same origin so no CORS/mixed-content concerns and it works through Remote
// Connect or an IP-address URL, where the direct hostname below never
// resolves from the browser). If the proxy itself is unreachable (nginx not
// yet updated, mid-upgrade, etc.) we fall back to querying Prometheus
// directly — it also answers the Admin's origin with
// Access-Control-Allow-Origin (verified on the test box). Labels `client`
// and `network` are set by the AVADO Prometheus scrape config.
export const PROMETHEUS_BASES = ["/metrics-api", "http://prometheus.my.ava.do:9090/api/v1"];

export const QUERIES = {
  headSlot: "max by (client, network) (beacon_head_slot)",
  peers: 'max by (client, network) (libp2p_peers or p2p_peer_count{state="Connected"})',
  attesterMiss:
    "sum by (client, network) (increase(validator_monitor_prev_epoch_on_chain_attester_miss_total[1h]))",
  attesterHit:
    "sum by (client, network) (increase(validator_monitor_prev_epoch_on_chain_attester_hit_total[1h]))",
};

// A stuck/unreachable Prometheus (e.g. through Remote Connect, or a network
// blip) must not hang a query indefinitely — the 60s poll interval in
// HealthProvider would otherwise pile up more in-flight requests behind it.
// Each base attempt below gets its own budget, so a fully-hung double
// failure (proxy then direct) takes up to 2x this, not indefinitely.
const PROMETHEUS_TIMEOUT_MS = 10000;

// Index into PROMETHEUS_BASES of the base that last answered successfully.
// Once one base is confirmed reachable it is tried first on every later
// query (within this page load), so a box that only reaches Prometheus one
// way (e.g. same-origin proxy but not the direct hostname) doesn't pay for a
// doomed attempt on every 60s poll. The four queries in fetchMetrics run
// concurrently, so this can be written by more than one in-flight query;
// that's fine — it just picks whichever base most recently won, and a wrong
// guess self-corrects on the next fallback.
let workingBaseIndex = 0;

export function resetPrometheusBase() {
  workingBaseIndex = 0;
}

async function queryOnce(base, q, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROMETHEUS_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${base}/query?query=${encodeURIComponent(q)}`, {
      signal: controller.signal,
    });
    if (!res.ok) throw Error(`Prometheus HTTP error`);
    const body = await res.json();
    if (body.status !== "success") throw Error(body.error || "Prometheus query failed");
    return body.data.result.map(({ metric, value }) => ({
      client: metric.client,
      network: metric.network,
      value: Number(value[1]),
    }));
  } finally {
    clearTimeout(timer);
  }
}

async function query(q, fetchImpl) {
  const order = workingBaseIndex === 0 ? [0, 1] : [1, 0];
  let lastError;
  for (const i of order) {
    try {
      const result = await queryOnce(PROMETHEUS_BASES[i], q, fetchImpl);
      workingBaseIndex = i;
      return result;
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError;
}

export async function fetchMetrics(fetchImpl = fetch) {
  try {
    const entries = await Promise.all(
      Object.entries(QUERIES).map(async ([key, q]) => [key, await query(q, fetchImpl)])
    );
    return Object.fromEntries(entries);
  } catch (e) {
    console.warn(`Prometheus unavailable: ${e.message}`);
    return null;
  }
}
