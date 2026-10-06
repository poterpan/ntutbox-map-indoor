// Campus 3D building models (glTF) for the campus view. The models are not open data: they sit behind
// models.ntutbox.com, which only answers requests that carry a short-lived token from the host site.
// This source hides that handshake; the engine only asks for the manifest and one building's GLB.
//
//   source.load()     → manifest { schema_version, crs, buildings: { [id]: { centroidEN, file, … } } }
//   source.glb(id)    → ArrayBuffer of that building's GLB (glTF Y-up, origin at centroidEN, ground level)
//
// tokenUrl answers { token, expiresAt (unix s), base } — see README「3D 建物模型」. Any object with load() and
// glb() works as the engine's `models` option.
export const MODELS_SCHEMA_VERSION = 1;
const REFRESH_MARGIN_S = 60;

export function campusModelSource({
  tokenUrl = '/api/model-token',
  fetch: fetchImpl = globalThis.fetch.bind(globalThis),
  now = () => Date.now() / 1000,
} = {}) {
  let grant = null; // Promise<{ token, expiresAt, base }>
  let loaded = null;
  const glbs = new Map();

  function token(force = false) {
    if (force) grant = null;
    grant ??= (async () => {
      const res = await fetchImpl(tokenUrl, { credentials: 'same-origin', cache: 'no-store' });
      if (!res.ok) throw Object.assign(new Error(`model token ${res.status}`), { status: res.status });
      const body = await res.json();
      if (!body?.token || !body?.base || !Number.isFinite(body.expiresAt)) throw new Error('model token response is malformed');
      return body;
    })();
    grant.catch(() => { grant = null; });
    return grant.then(g => (g.expiresAt - REFRESH_MARGIN_S <= now() ? token(true) : g));
  }

  // One retry with a fresh token on 401: a token can expire between minting and use (sleeping tab).
  async function get(path, retried = false) {
    const g = await token();
    const res = await fetchImpl(`${g.base}/${path}`, { headers: { Authorization: `Bearer ${g.token}` }, mode: 'cors' });
    if (res.status === 401 && !retried) {
      await token(true);
      return get(path, true);
    }
    if (!res.ok) throw Object.assign(new Error(`${res.status} models/${path}`), { status: res.status });
    return res;
  }

  function load() {
    loaded ??= (async () => {
      const current = await (await get('current.json')).json();
      if (current.schema_version !== MODELS_SCHEMA_VERSION) {
        throw new Error(`campus models schema ${current.schema_version} is not supported (expected ${MODELS_SCHEMA_VERSION})`);
      }
      const manifest = await (await get(current.manifest)).json();
      if (manifest.crs !== 'EPSG:3826' || !manifest.buildings) throw new Error('campus models manifest is not in EPSG:3826');
      return manifest;
    })();
    loaded.catch(() => { loaded = null; });
    return loaded;
  }

  return {
    load,
    glb(id) {
      if (!glbs.has(id)) {
        const p = load().then(m => {
          const entry = m.buildings[id];
          if (!entry) throw new Error(`no model for ${id}`);
          return get(entry.file).then(r => r.arrayBuffer());
        });
        p.catch(() => glbs.delete(id));
        glbs.set(id, p);
      }
      return glbs.get(id);
    },
  };
}
