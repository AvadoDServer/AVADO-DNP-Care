// Fee recipients of the validator keys loaded in each validator client, read
// through the standard keymanager API that every AVADO validator package
// serves at :9999/keymanager (the package adds its keymanager token server
// side and answers any origin: CORS is open on those routes). The same routes
// are used by the Rocket Pool backend and AVADO-Client-UI.
//
// Result per validator package that could be read:
//   { validators, checked, missing }
// `missing` counts checked keys whose fee recipient is the zero address, or
// whose client says in so many words that none is set (a 404/500 whose
// message mentions the fee recipient, e.g. Lighthouse's "no fee recipient
// set"). A bare 404 is ambiguous (unknown key, route missing on an old
// client) and makes the whole client "unknown". A client that cannot be read
// (not running, no answer, an unexpected reply) is left out entirely, so the
// rule never raises a finding on data it could not see. Only whether an
// address is set is looked at; no address or pubkey leaves this module.

export const VALIDATOR_CLIENTS = [
  { name: "nimbus.avado.dnp.dappnode.eth", keymanager: "http://nimbus.my.ava.do:9999/keymanager" },
  { name: "teku.avado.dnp.dappnode.eth", keymanager: "http://teku.my.ava.do:9999/keymanager" },
  { name: "lighthouse.avado.dnp.dappnode.eth", keymanager: "http://lighthouse.my.ava.do:9999/keymanager" },
  // Prysm: the validator client and its keys live in the eth2validator package
  { name: "eth2validator.avado.dnp.dappnode.eth", keymanager: "http://eth2validator.my.ava.do:9999/keymanager" },
];

// At most this many keys are checked per client on each run, so a box with
// hundreds of validators does not fire hundreds of requests at once.
export const MAX_KEYS_CHECKED = 64;
const TIMEOUT_MS = 10000;
const ZERO_ADDRESS = /^0x0{40}$/i;
const ADDRESS = /^0x[0-9a-f]{40}$/i;
const PUBKEY = /^0x[0-9a-f]{96}$/i;
const SAYS_NOT_SET = /fee.?recipient|suggested/i;

async function getJson(fetchImpl, url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { signal: controller.signal, headers: { Accept: "application/json" } });
    let body = null;
    try {
      body = await res.json();
    } catch (e) {
      body = null;
    }
    return { status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

/** One client: { validators, checked, missing }, or null when it cannot be read. */
export async function readClientFeeRecipients(client, fetchImpl = fetch) {
  try {
    const list = await getJson(fetchImpl, `${client.keymanager}/eth/v1/keystores`);
    if (list.status !== 200 || !list.body || !Array.isArray(list.body.data)) return null;
    const pubkeys = list.body.data
      .map(k => k && (k.validating_pubkey || k.pubkey))
      .filter(pk => typeof pk === "string" && PUBKEY.test(pk));
    if (pubkeys.length !== list.body.data.length) return null; // unexpected shape: don't guess
    const sample = pubkeys.slice(0, MAX_KEYS_CHECKED);
    let missing = 0;
    for (const pk of sample) {
      const r = await getJson(fetchImpl, `${client.keymanager}/eth/v1/validator/${pk}/feerecipient`);
      const message = r.body && typeof r.body.message === "string" ? r.body.message : "";
      if ((r.status === 404 || r.status === 500) && SAYS_NOT_SET.test(message)) {
        missing++;
        continue;
      }
      const address = r.status === 200 && r.body && r.body.data ? r.body.data.ethaddress : undefined;
      if (typeof address !== "string" || !ADDRESS.test(address)) return null; // an error or an odd reply: unknown
      if (ZERO_ADDRESS.test(address)) missing++;
    }
    return { validators: pubkeys.length, checked: sample.length, missing };
  } catch (e) {
    return null;
  }
}

/**
 * Reads every installed, running validator client. Returns an object keyed by
 * package name (clients that could not be read are absent), or null when no
 * validator client runs at all.
 */
export async function fetchFeeRecipients(packages, fetchImpl = fetch) {
  const running = new Set((packages || []).filter(p => p && p.running).map(p => p.name));
  const clients = VALIDATOR_CLIENTS.filter(c => running.has(c.name));
  if (!clients.length) return null;
  const out = {};
  for (const client of clients) {
    const r = await readClientFeeRecipients(client, fetchImpl);
    if (r) out[client.name] = r;
  }
  return out;
}
