// Mission V3 — Wave Planner (pure, no I/O)
//   Turns sub-phases (with dependencies + optional est files) into parallel waves.
//   Same wave = no inter-dependency AND no file collision AND under concurrency cap.
//   Cycle in the dependency graph throws (caller turns it into a mission error).
//
//   Used ONLY by the MISSION_PARALLEL execution path. The sequential path never
//   imports this — keeping flag-off behaviour byte-for-byte unchanged.

'use strict';

const DEFAULT_MAX = Number(process.env.MISSION_PARALLEL_MAX || 3);

function normId(x) {
  return String(x == null ? '' : x).trim();
}

function normFiles(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map((x) => String(x == null ? '' : x).trim()).filter(Boolean);
}

/**
 * @param {Array} subPhases  [{ id, dependencies?:string[], estFiles?:string[] }]
 * @param {Object} opts      { maxConcurrency?:number }
 * @returns {{ waves: Array<Array>, order: string[], warnings: string[] }}
 */
function planWaves(subPhases, opts = {}) {
  const maxConcurrency = Math.max(1, Number(opts.maxConcurrency || DEFAULT_MAX) || 1);
  const warnings = [];
  const list = (Array.isArray(subPhases) ? subPhases : []).filter(Boolean);
  if (list.length === 0) return { waves: [], order: [], warnings };

  // 1) Index by id, repair duplicate / missing ids.
  const byId = new Map();
  list.forEach((sp, idx) => {
    let id = normId(sp.id) || `p${idx + 1}`;
    if (byId.has(id)) {
      const fixed = `${id}#${idx}`;
      warnings.push(`duplicate sub-phase id "${id}" renamed to "${fixed}"`);
      id = fixed;
    }
    byId.set(id, { ...sp, id, _idx: idx });
  });
  const all = Array.from(byId.values()).sort((a, b) => a._idx - b._idx);

  // 2) Validate dependencies: drop self-deps and dangling refs.
  const deps = new Map();
  for (const sp of all) {
    const raw = Array.isArray(sp.dependencies) ? sp.dependencies.map(normId) : [];
    const valid = new Set();
    for (const d of raw) {
      if (!d) continue;
      if (d === sp.id) { warnings.push(`sub-phase "${sp.id}" self-dependency ignored`); continue; }
      if (!byId.has(d)) { warnings.push(`sub-phase "${sp.id}" dependency "${d}" not found, ignored`); continue; }
      valid.add(d);
    }
    deps.set(sp.id, valid);
  }

  // 3) File-collision lookup (only when planner supplied estFiles).
  const files = new Map();
  for (const sp of all) files.set(sp.id, new Set(normFiles(sp.estFiles)));
  const collides = (idA, idB) => {
    const a = files.get(idA);
    const b = files.get(idB);
    if (!a || !b || a.size === 0 || b.size === 0) return false;
    for (const f of a) if (b.has(f)) return true;
    return false;
  };

  // 4) Greedy wave assignment honouring deps + cap + collision.
  const completed = new Set();
  const order = [];
  const waves = [];

  while (completed.size < all.length) {
    const ready = all.filter(
      (sp) => !completed.has(sp.id) &&
        [...deps.get(sp.id)].every((d) => completed.has(d)),
    );

    if (ready.length === 0) {
      const stuck = all.filter((sp) => !completed.has(sp.id)).map((sp) => sp.id);
      throw new Error(`wave-planner: dependency cycle or unsatisfiable deps among [${stuck.join(', ')}]`);
    }

    const wave = [];
    for (const sp of ready) {
      if (wave.length >= maxConcurrency) break;
      if (wave.some((w) => collides(sp.id, w.id))) continue; // hold collider for a later wave
      wave.push(sp);
    }

    for (const sp of wave) {
      completed.add(sp.id);
      order.push(sp.id);
    }
    waves.push(wave);
  }

  return { waves, order, warnings };
}

module.exports = { planWaves };
