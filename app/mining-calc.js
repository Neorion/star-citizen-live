/* mining-calc.js — pure rock-crack engine for the Star Citizen mining calculator.
 * No DOM, no I/O, no dependencies. Works as a CommonJS module (Node, tests) and as
 * a browser global (`window.MiningCalc`) so the same file backs app/mining.html and
 * can be lifted into the GoonCitizen React app unchanged.
 *
 * MODEL (community, not published by CIG — see DESIGN-mining-calculator.md §2):
 *   R_eff  = R_rock/100 × M         M = Π (1 + mod/100) over head, counted modules, gadget
 *   P_need = c × mass / (1 − R_eff) c = 0.2  ⇔  mass_max = 5 × P × (1 − R_eff)
 *   P_head = P_max × Π (1 + laserPower/100) over counted modules
 * Passive modules always count; active modules count only when `active: true`.
 * Multi-laser rule is a parameter (§2.1): 'per-head' (default, conservative — each
 * head cracks its own share) or 'pooled' (sum power, multiply resistance factors).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MiningCalc = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const C = 0.2;
  const factor = (pct) => 1 + ((Number(pct) || 0) / 100);

  function index (ref) {
    const by = (arr) => { const m = Object.create(null); (arr || []).forEach(x => { m[x.id] = x; }); return m; };
    return { lasers: by(ref.lasers), modules: by(ref.modules), gadgets: by(ref.gadgets), ships: by(ref.ships) };
  }

  // Resolve one laser slot → { name, pMax, pMin, m (resistance factor, excl. gadget), inst (factor), slots }
  function resolveLaser (slot, ix) {
    const head = ix.lasers[slot.head];
    if (!head) return null;
    let pMax = head.power.max, pMin = head.power.min, m = factor(head.resistance), inst = factor(head.instability);
    const mods = (slot.modules || []).slice(0, head.moduleSlots || 0);
    for (const s of mods) {
      const mod = s && ix.modules[s.id];
      if (!mod) continue;
      if (mod.active && !s.active) continue;      // consumable not fired → no effect
      pMax *= factor(mod.laserPower); pMin *= factor(mod.laserPower);
      m *= factor(mod.resistance); inst *= factor(mod.instability);
    }
    return { name: head.name, head: head.id, pMax, pMin, m, inst, slots: head.moduleSlots || 0 };
  }

  // Same-throttle solution for a set of resolved lasers against a rock.
  // Returns { t (throttle 0..∞, Infinity = unbreakable), pNeed (MW at that throttle), rEff }
  function solve (lasers, rock, gadgetM, combine) {
    const R = (Number(rock.resistance) || 0) / 100;
    const mass = Number(rock.mass) || 0;
    if (!lasers.length || mass <= 0) return { t: 0, pNeed: 0, rEff: R * gadgetM };
    if (combine === 'pooled') {
      const P = lasers.reduce((s, l) => s + l.pMax, 0);
      const M = lasers.reduce((s, l) => s * l.m, 1) * gadgetM;
      const rEff = Math.min(1, R * M);
      if (rEff >= 1) return { t: Infinity, pNeed: Infinity, rEff };
      const pNeed = C * mass / (1 - rEff);
      return { t: pNeed / P, pNeed, rEff };
    }
    // per-head: capacity_i = 5·P_i·(1 − R·M_i·gadget); all heads at throttle t
    let cap = 0, P = 0, rSum = 0;
    for (const l of lasers) {
      const rEff = Math.min(1, R * l.m * gadgetM);
      rSum += rEff; P += l.pMax;
      cap += 5 * l.pMax * (1 - rEff);
    }
    if (cap <= 0) return { t: Infinity, pNeed: Infinity, rEff: rSum / lasers.length };
    const t = mass / cap;
    return { t, pNeed: t * P, rEff: rSum / lasers.length };
  }

  function verdictFor (t, margin) {
    if (!isFinite(t)) return 'unbreakable';
    if (t <= 1 - margin) return 'ok';
    if (t <= 1) return 'marginal';
    return 'short';
  }

  /**
   * compute(input, ref) → result
   * input = { rock:{mass,resistance,instability}, lasers:[{head, modules:[{id,active}]}],
   *           gadget: id|null, options:{ combine:'per-head'|'pooled', margin:0.15 } }
   */
  function compute (input, ref) {
    const ix = index(ref);
    const opt = Object.assign({ combine: (ref.model && ref.model.combine) || 'per-head', margin: (ref.model && ref.model.margin) || 0.15 }, input.options || {});
    const rock = Object.assign({ mass: 0, resistance: 0, instability: 0 }, input.rock || {});
    const lasers = (input.lasers || []).map(s => resolveLaser(s, ix)).filter(Boolean);
    const gadget = input.gadget ? ix.gadgets[input.gadget] : null;
    const gadgetM = gadget ? factor(gadget.resistance) : 1;
    const gadgetI = gadget ? factor(gadget.instability) : 1;

    const all = solve(lasers, rock, gadgetM, opt.combine);
    const verdict = verdictFor(all.t, opt.margin);

    // Per-laser view: what this head alone would need, and its share at the common throttle.
    const perLaser = lasers.map(l => {
      const solo = solve([l], rock, gadgetM, opt.combine);
      return { head: l.head, name: l.name, pMax: round(l.pMax, 1), pMin: round(l.pMin, 1), resistanceFactor: round(l.m * gadgetM, 3),
        throttle: isFinite(all.t) ? round(all.t * 100, 1) : Infinity, soloThrottle: isFinite(solo.t) ? round(solo.t * 100, 1) : Infinity,
        soloVerdict: verdictFor(solo.t, opt.margin), mwAtThrottle: isFinite(all.t) ? round(all.t * l.pMax) : Infinity };
    });

    // Fewest heads that can do it (prefer fewer lasers, like a MOLE choosing who fires).
    let bestSubset = null;
    if (lasers.length > 1 && verdict !== 'unbreakable') {
      const n = lasers.length;
      outer: for (let size = 1; size <= n; size++) {
        for (let mask = 1; mask < (1 << n); mask++) {
          if (popcount(mask) !== size) continue;
          const sub = lasers.filter((_, i) => mask & (1 << i));
          const s = solve(sub, rock, gadgetM, opt.combine);
          if (s.t <= 1 - opt.margin) { bestSubset = { heads: sub.map(l => l.name), throttle: round(s.t * 100, 1) }; break outer; }
        }
      }
    }

    // What would tip it: try each gadget, and each unfired consumable, when short.
    const tips = [];
    if (verdict === 'short' || verdict === 'marginal' || verdict === 'unbreakable') {
      for (const g of (ref.gadgets || [])) {
        if (gadget && g.id === gadget.id) continue;
        const s = solve(lasers, rock, factor(g.resistance), opt.combine);
        if (s.t <= 1 - opt.margin) tips.push({ kind: 'gadget', id: g.id, name: g.name, throttle: round(s.t * 100, 1) });
      }
      const inactive = [];
      (input.lasers || []).forEach((slot, li) => (slot.modules || []).forEach((s, mi) => {
        const mod = s && ix.modules[s.id];
        if (mod && mod.active && !s.active) inactive.push({ li, mi, mod });
      }));
      for (const c of inactive) {
        const clone = JSON.parse(JSON.stringify(input.lasers));
        clone[c.li].modules[c.mi].active = true;
        const s = solve(clone.map(x => resolveLaser(x, ix)).filter(Boolean), rock, gadgetM, opt.combine);
        if (s.t <= 1 - opt.margin) tips.push({ kind: 'module', id: c.mod.id, name: c.mod.name, laser: lasers[c.li] && lasers[c.li].name, throttle: round(s.t * 100, 1) });
      }
      tips.sort((a, b) => a.throttle - b.throttle);
    }

    const instFactor = lasers.reduce((s, l) => s * l.inst, 1) * gadgetI;
    const iEff = (Number(rock.instability) || 0) * (lasers.length ? instFactor : 1);

    return {
      model: 'community-v1', combine: opt.combine, margin: opt.margin,
      verdict, throttle: isFinite(all.t) ? round(all.t * 100, 1) : Infinity,
      pNeed: isFinite(all.pNeed) ? round(all.pNeed) : Infinity,
      pAvailable: round(lasers.reduce((s, l) => s + l.pMax, 0)),
      shortfallMW: isFinite(all.pNeed) ? Math.max(0, round(all.pNeed - lasers.reduce((s, l) => s + l.pMax, 0))) : Infinity,
      rEff: round(all.rEff * 100, 1),
      iEff: round(iEff, 1), iBand: iEff >= 60 ? 'high' : iEff >= 35 ? 'mid' : 'low',
      massMax: isFinite(all.t) && all.t > 0 ? round((Number(rock.mass) || 0) / all.t) : null,
      perLaser, bestSubset, tips
    };
  }

  function popcount (x) { let c = 0; while (x) { c += x & 1; x >>= 1; } return c; }
  function round (v, d) { const p = Math.pow(10, d || 0); return Math.round(v * p) / p; }

  return { compute, solve, resolveLaser, C, VERSION: 1 };
}));
