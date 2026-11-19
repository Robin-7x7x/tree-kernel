#!/usr/bin/env node
/**
 * tree-kernel.mjs — evidence-backed task-tree kernel for Pi (Node 18+, no deps).
 *
 * Important integration rule: Pi must route every tool invocation through
 * executeTool() below. Calling the CLI `policy` command alone is advisory and
 * does not enforce anything. The host should expose only its guarded tool
 * wrapper to the model, and provide authorizeExternal() from a trusted UI.
 *
 * State is derived from immutable-ish evidence and revision-bound approvals:
 *   leaf: verified only with evidence for its current revision
 *   parent: verified only with all children verified and a current review
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const VERSION = 2;
const LOCK_TIMEOUT_MS = 5000;
const STALE_LOCK_MS = 60000;
const EMPTY = () => ({ version: VERSION, generation: 0, updatedAt: new Date().toISOString(), nodes: [], evidence: [], approvals: [], executions: [], graves: [], events: [] });
const now = () => new Date().toISOString();
const short = (x, n = 3000) => String(x ?? '').slice(0, n);
const hash = (x) => createHash('sha256').update(JSON.stringify(x)).digest('hex');

function load(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return EMPTY(); throw e; }
  let s;
  try { s = JSON.parse(raw); } catch (e) { throw new Error(`State file is invalid JSON; preserved without overwrite: ${e.message}`); }
  if (!s || s.version !== VERSION || !Array.isArray(s.nodes) || !Array.isArray(s.evidence) || !Array.isArray(s.approvals) || !Array.isArray(s.executions)) {
    throw new Error(`Unsupported or malformed state (expected version ${VERSION}); state was not changed.`);
  }
  return s;
}

function lock(file) {
  const lockFile = `${path.resolve(file)}.lock`;
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  const start = Date.now();
  while (true) {
    try {
      const fd = fs.openSync(lockFile, 'wx', 0o600);
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: now() }));
      return () => { try { fs.closeSync(fd); } catch {} try { fs.unlinkSync(lockFile); } catch {} };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        if (Date.now() - fs.statSync(lockFile).mtimeMs > STALE_LOCK_MS) { fs.unlinkSync(lockFile); continue; }
      } catch { continue; }
      if (Date.now() - start > LOCK_TIMEOUT_MS) throw new Error('Timed out waiting for state lock.');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
}

function save(file, s) {
  const target = path.resolve(file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(s, null, 2) + '\n');
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    fs.renameSync(tmp, target);
    try { const dir = fs.openSync(path.dirname(target), 'r'); fs.fsyncSync(dir); fs.closeSync(dir); } catch {}
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(tmp); } catch {}
  }
}

function transact(file, fn) {
  const unlock = lock(file);
  try {
    const s = load(file);
    const result = fn(s);
    if (result?.changed !== false) {
      s.generation++;
      s.updatedAt = now();
      s.events.push({ id: randomUUID(), at: s.updatedAt, type: result?.event ?? 'state.changed', detail: short(result?.detail, 1000) });
      if (s.events.length > 2000) s.events.splice(0, s.events.length - 2000);
      save(file, s);
    }
    return result?.value;
  } finally { unlock(); }
}

function graph(s) {
  const byId = new Map(s.nodes.map(n => [n.id, n]));
  const children = new Map(s.nodes.map(n => [n.id, []]));
  for (const n of s.nodes) if (n.parent && byId.has(n.parent)) children.get(n.parent).push(n);
  const roots = s.nodes.filter(n => !n.parent);
  const reachable = new Set();
  const walk = (n) => { if (reachable.has(n.id)) return; reachable.add(n.id); for (const c of children.get(n.id) ?? []) walk(c); };
  roots.forEach(walk);
  const ancestors = (id) => { const out = [], seen = new Set(); let n = byId.get(id); while (n && !seen.has(n.id)) { seen.add(n.id); out.push(n); n = n.parent ? byId.get(n.parent) : null; } return out; };
  const subtree = (id) => { const out = [], todo = [byId.get(id)].filter(Boolean), seen = new Set(); while (todo.length) { const n = todo.pop(); if (seen.has(n.id)) continue; seen.add(n.id); out.push(n); todo.push(...(children.get(n.id) ?? [])); } return out; };
  const approvalFor = (n) => s.approvals.find(a => a.nodeId === n.id && a.revision === n.revision && a.snapshot === snapshot(n.id));
  const snapshot = (id) => hash(subtree(id).map(n => [n.id, n.parent, n.goal, n.revision, !!n.stale]).sort((a,b) => a[0].localeCompare(b[0])));
  const evidenceFor = (id, rev) => s.evidence.filter(e => e.nodeId === id && e.revision === rev);
  const verified = (n, visiting = new Set()) => {
    if (!n || n.stale || n.hold || visiting.has(n.id)) return false;
    const kids = children.get(n.id) ?? [];
    if (kids.length) {
      const next = new Set(visiting); next.add(n.id);
      return kids.every(c => verified(c, next)) && !!approvalFor(n);
    }
    return evidenceFor(n.id, n.revision).length > 0 && !!approvalFor(n);
  };
  const status = (n) => {
    if (n.stale) return 'stale';
    if (n.hold) return 'blocked';
    const kids = children.get(n.id) ?? [];
    if (verified(n)) return 'verified';
    if (kids.length && kids.every(c => verified(c))) return 'awaiting_review';
    return evidenceFor(n.id, n.revision).length ? 'awaiting_review' : 'planned';
  };
  return { byId, children, roots, reachable, ancestors, subtree, snapshot, evidenceFor, verified, status };
}

function invalidateAncestors(s, id, includeSelf = false) {
  const g = graph(s);
  for (const n of g.ancestors(id)) {
    if (!includeSelf && n.id === id) continue;
    n.revision++;
    s.approvals = s.approvals.filter(a => a.nodeId !== n.id);
  }
}
function needNode(s, id) { const n = s.nodes.find(x => x.id === id); if (!n) throw new Error(`Node ${id || '(missing)'} does not exist.`); return n; }
function addEvent(s, type, detail) { s.events.push({ id: randomUUID(), at: now(), type, detail: short(detail, 1000) }); }

export class TreeKernel {
  constructor(stateFile = './.tree-state.json') { this.stateFile = path.resolve(stateFile); }
  read() { return load(this.stateFile); }

  begin({ goal, from = '', parent = null, hold = false } = {}) {
    goal = short(goal, 2000).trim(); if (!goal) throw new Error('goal is required');
    return transact(this.stateFile, s => {
      const g = graph(s); if (parent) needNode(s, parent);
      const id = `n${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;
      const n = { id, parent: parent || null, goal, from: parent ? undefined : short(from, 2000).trim() || undefined, revision: 1, stale: false, hold: !!hold, createdAt: now() };
      s.nodes.push(n);
      if (parent) invalidateAncestors(s, parent, true);
      addEvent(s, 'node.created', `${id}: ${goal}`);
      return { value: { id }, event: 'node.created', detail: goal };
    });
  }

  edit({ nodeId, goal } = {}) {
    goal = short(goal, 2000).trim(); if (!goal) throw new Error('goal is required');
    return transact(this.stateFile, s => {
      const n = needNode(s, nodeId), g = graph(s);
      n.goal = goal; n.revision++; n.stale = false;
      s.approvals = s.approvals.filter(a => a.nodeId !== n.id);
      for (const d of g.subtree(n.id)) if (d.id !== n.id) { d.stale = true; d.revision++; s.approvals = s.approvals.filter(a => a.nodeId !== d.id); }
      invalidateAncestors(s, n.id);
      addEvent(s, 'node.edited', `${n.id}: ${goal}`);
      return { value: { id: n.id }, event: 'node.edited', detail: goal };
    });
  }

  prune({ nodeId, why = '' } = {}) {
    return transact(this.stateFile, s => {
      const n = needNode(s, nodeId), g = graph(s), removed = new Set(g.subtree(n.id).map(x => x.id));
      const parent = n.parent;
      s.graves.push({ at: now(), goal: n.goal, why: short(why, 1000), removed: [...removed] });
      s.graves = s.graves.slice(-200);
      s.nodes = s.nodes.filter(x => !removed.has(x.id));
      s.evidence = s.evidence.filter(x => !removed.has(x.nodeId));
      s.approvals = s.approvals.filter(x => !removed.has(x.nodeId));
      if (parent && s.nodes.some(x => x.id === parent)) invalidateAncestors(s, parent, true);
      addEvent(s, 'node.pruned', `${n.goal}; ${why}`);
      return { value: { removed: removed.size }, event: 'node.pruned', detail: why };
    });
  }

  hold({ nodeId, on = true } = {}) {
    return transact(this.stateFile, s => { const n = needNode(s, nodeId); n.hold = !!on; addEvent(s, on ? 'node.held' : 'node.released', n.id); return { value: { id: n.id, hold: n.hold }, event: on ? 'node.held' : 'node.released', detail: n.id }; });
  }

  addEvidence({ nodeId, kind, value, source = 'model' } = {}) {
    kind = short(kind, 100).trim(); value = short(value, 5000).trim();
    if (!kind || !value) throw new Error('kind and value are required');
    return transact(this.stateFile, s => {
      const n = needNode(s, nodeId); if (n.stale) throw new Error('Cannot add evidence to a stale node; revise or replan it first.');
      const e = { id: `e-${randomUUID()}`, nodeId, revision: n.revision, kind, value, source: short(source, 300), at: now() };
      s.evidence.push(e); addEvent(s, 'evidence.added', `${nodeId}: ${kind}`);
      return { value: e, event: 'evidence.added', detail: `${nodeId}: ${kind}` };
    });
  }

  verify({ nodeId, review, evidenceIds = [] } = {}) {
    review = short(review, 2000).trim();
    return transact(this.stateFile, s => {
      const n = needNode(s, nodeId), g = graph(s), kids = g.children.get(n.id) ?? [];
      if (!g.reachable.has(n.id)) throw new Error('Node is unreachable (missing parent or cycle).');
      if (n.stale || g.ancestors(n.id).some(a => a.hold)) throw new Error('Node or ancestor is stale/held.');
      if (kids.some(c => !g.verified(c))) throw new Error('All child nodes must be verified before reviewing this parent.');
      const ids = [...new Set(evidenceIds)];
      if (!kids.length) {
        const own = g.evidenceFor(n.id, n.revision).map(e => e.id);
        if (!own.length) throw new Error('A leaf needs evidence before it can be verified.');
        if (ids.length && ids.some(id => !own.includes(id))) throw new Error('Leaf verification may reference only its own current-revision evidence.');
      } else {
        const available = new Set(s.evidence.filter(e => g.subtree(n.id).some(d => d.id === e.nodeId)).map(e => e.id));
        if (ids.some(id => !available.has(id))) throw new Error('Review references evidence outside this subtree.');
      }
      if (!review) throw new Error('A non-empty review conclusion is required.');
      const approval = { id: `a-${randomUUID()}`, nodeId, revision: n.revision, snapshot: g.snapshot(nodeId), review, evidenceIds: ids, reviewer: 'adapter-or-cli', at: now() };
      s.approvals = s.approvals.filter(a => a.nodeId !== nodeId); s.approvals.push(approval);
      addEvent(s, 'node.verified', `${nodeId}: ${review}`);
      return { value: approval, event: 'node.verified', detail: `${nodeId}: ${review}` };
    });
  }

  authorizeTool({ nodeId, toolClass = 'readonly', purpose = '' } = {}) {
    const s = this.read(), g = graph(s);
    if (!['readonly', 'mutating', 'external'].includes(toolClass)) return { allowed: false, reason: 'Unknown tool class.' };
    if (toolClass === 'readonly') return { allowed: true, reason: 'Read-only operations are allowed; keep discovery within the task scope.' };
    if (!nodeId || !g.byId.has(nodeId)) return { allowed: false, reason: 'Mutating/external tools require a planned leaf node.' };
    const n = g.byId.get(nodeId), chain = g.ancestors(nodeId);
    if (!g.reachable.has(nodeId)) return { allowed: false, reason: 'Node is unreachable.' };
    if (chain.some(a => a.hold)) return { allowed: false, reason: 'Node or ancestor is on hold.' };
    if (chain.some(a => a.stale)) return { allowed: false, reason: 'Node or ancestor is stale; replan first.' };
    if ((g.children.get(nodeId) ?? []).length) return { allowed: false, reason: 'Choose a leaf node for execution.' };
    if (n.parent && (g.children.get(n.parent) ?? []).length === 1 && g.byId.get(n.parent)?.goal === n.goal) return { allowed: false, reason: 'Plan is not meaningfully decomposed.' };
    return { allowed: true, reason: toolClass === 'external' ? 'External action still requires trusted user authorization.' : 'Planned leaf is eligible.', nodeId, purpose: short(purpose, 500) };
  }

  /**
   * Mandatory host wrapper. The executor is never called unless policy allows it.
   * External actions additionally require authorizeExternal() implemented by Pi
   * using a trusted user-confirmation channel (never a model-controlled flag).
   */
  async executeTool({ nodeId, tool, toolClass = 'readonly', purpose = '', authorizeExternal, args } = {}, executor) {
    if (typeof executor !== 'function') throw new Error('executor callback is required');
    const decision = this.authorizeTool({ nodeId, toolClass, purpose });
    if (!decision.allowed) throw new Error(`Tool call blocked: ${decision.reason}`);
    if (toolClass === 'external') {
      if (typeof authorizeExternal !== 'function' || !(await authorizeExternal({ nodeId, tool, purpose }))) throw new Error('External action requires explicit trusted user confirmation.');
    }
    const executionId = `x-${randomUUID()}`;
    transact(this.stateFile, s => { s.executions.push({ id: executionId, nodeId: nodeId || null, tool: short(tool, 200), toolClass, purpose: short(purpose, 500), args: short(JSON.stringify(args ?? null), 2000), status: 'running', startedAt: now() }); return { event: 'tool.started', detail: `${tool}: ${purpose}` }; });
    try {
      const result = await executor(args);
      const serialized = short(typeof result === 'string' ? result : JSON.stringify(result), 5000);
      transact(this.stateFile, s => {
        const x = s.executions.find(y => y.id === executionId); if (x) { x.status = 'succeeded'; x.result = serialized; x.finishedAt = now(); }
        if (nodeId) {
          const n = needNode(s, nodeId);
          s.evidence.push({ id: `e-${randomUUID()}`, nodeId, revision: n.revision, kind: 'tool-result', value: serialized, source: `${tool || 'tool'} (${executionId})`, at: now(), executionId });
        }
        return { event: 'tool.succeeded', detail: `${tool}: ${executionId}` };
      });
      return result;
    } catch (error) {
      transact(this.stateFile, s => { const x = s.executions.find(y => y.id === executionId); if (x) { x.status = 'failed'; x.error = short(error?.stack || error, 3000); x.finishedAt = now(); } return { event: 'tool.failed', detail: `${tool}: ${error?.message || error}` }; });
      throw error;
    }
  }

  view() {
    const s = this.read(), g = graph(s);
    return { version: s.version, generation: s.generation, roots: g.roots.map(n => n.id), unreachable: s.nodes.filter(n => !g.reachable.has(n.id)).map(n => n.id), nodes: s.nodes.map(n => ({ id: n.id, parent: n.parent, goal: n.goal, revision: n.revision, status: g.status(n), children: (g.children.get(n.id) ?? []).map(c => c.id), evidence: g.evidenceFor(n.id, n.revision).length, hold: !!n.hold })), executions: s.executions.length };
  }
}

function parse(argv) {
  const [cmd, ...rest] = argv, p = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]; if (!a.startsWith('--')) continue;
    const k = a.slice(2); if (k === 'hold' || k === 'on') p[k] = true; else p[k] = rest[++i];
  }
  return { cmd, p };
}
function help() {
  return `tree-kernel.mjs (Node 18+)\n` +
`  begin   --goal TEXT [--from TEXT] [--parent ID] [--hold]\n` +
`  edit    --node ID --goal TEXT\n` +
`  prune   --node ID [--why TEXT]\n` +
`  evidence --node ID --kind TYPE --value TEXT [--source TEXT]\n` +
`  verify  --node ID --review TEXT [--evidence ID,ID]\n` +
`  hold    --node ID | release --node ID\n` +
`  policy  [--node ID] --class readonly|mutating|external [--purpose TEXT]\n` +
`  view | reset | help\n` +
`  global: --state FILE (default ./.tree-state.json)\n\n` +
`Pi integration: import { TreeKernel } from this module and route every tool\n` +
`call through kernel.executeTool(...). External authorization must come from\n` +
`a trusted user-confirmation callback, not a model argument.`;
}

async function main() {
  const { cmd, p } = parse(process.argv.slice(2));
  const stateFile = p.state || './.tree-state.json';
  const k = new TreeKernel(stateFile);
  try {
    let out;
    if (cmd === 'begin') out = k.begin({ goal: p.goal, from: p.from, parent: p.parent, hold: p.hold });
    else if (cmd === 'edit') out = k.edit({ nodeId: p.node, goal: p.goal });
    else if (cmd === 'prune') out = k.prune({ nodeId: p.node, why: p.why });
    else if (cmd === 'evidence') out = k.addEvidence({ nodeId: p.node, kind: p.kind, value: p.value, source: p.source });
    else if (cmd === 'verify') out = k.verify({ nodeId: p.node, review: p.review, evidenceIds: p.evidence ? p.evidence.split(',').filter(Boolean) : [] });
    else if (cmd === 'hold') out = k.hold({ nodeId: p.node, on: true });
    else if (cmd === 'release') out = k.hold({ nodeId: p.node, on: false });
    else if (cmd === 'policy') out = k.authorizeTool({ nodeId: p.node, toolClass: p.class || 'readonly', purpose: p.purpose });
    else if (cmd === 'view') out = k.view();
    else if (cmd === 'reset') {
      const s = k.read();
      if (s.nodes.length || s.evidence.length) {
        const archive = `${stateFile}.archive-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
        fs.writeFileSync(archive, JSON.stringify(s, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      }
      transact(stateFile, s2 => { Object.assign(s2, EMPTY()); return { event: 'tree.reset', detail: 'reset with archive' }; });
      out = { reset: true };
    } else { console.log(help()); return; }
    console.log(JSON.stringify(out, null, 2));
  } catch (e) { console.error(`✗ ${e.message}`); process.exitCode = 1; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
