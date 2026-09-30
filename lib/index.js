/**
 * dsh-quick-restart — host half.
 *
 *   GET  /dsh-quick-restart/api/status   → who we are, and whether restarting is safe
 *   POST /dsh-quick-restart/api/restart  → hand off to a detached helper that rebuilds the app
 *
 * The restart cannot happen in-process — the process doing it is the process being
 * replaced — so the host only validates the request and forks lib/helper.mjs.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = 'dsh-quick-restart';

export const inject = ['webServer'];

const ROUTE = '/dsh-quick-restart/api';
const CSRF_HEADER = 'x-dsh-quick-restart';
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost']);

let restarting = false;

function send(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

/** Desktop shells run the host inside the Electron binary in Node mode. */
function kind() {
  const electronNode = process.env.ELECTRON_RUN_AS_NODE === '1';
  return electronNode && /\.exe$/i.test(process.execPath || '') ? 'desktop' : 'web';
}

/** The port this page is served on. argv is unreliable; the request is not. */
function servingPort(req) {
  const match = String(req?.headers?.host || '').match(/:(\d{1,5})$/u);
  return match ? Number(match[1]) : Number(process.env.PORT) || 19387;
}

/**
 * Only same-origin loopback callers may restart the app. The desktop shell talks
 * over the dsh-app:// protocol, plain `dsh web` talks over http://127.0.0.1:PORT.
 */
function untrusted(req) {
  const headers = req?.headers || {};
  if (!LOOPBACK.has(String(req?.socket?.remoteAddress || ''))) return 'remote address is not loopback';
  if (headers.forwarded || headers['x-forwarded-for'] || headers['x-forwarded-host'] || headers['x-real-ip']) {
    return 'request arrived through a proxy';
  }
  const origin = String(headers.origin || '');
  if (!origin || origin === 'null' || /^dsh-app:\/\//iu.test(origin)) return '';
  try {
    const parsed = new URL(origin);
    if (parsed.host !== String(headers.host || '')) return 'origin does not match host';
    if (!LOOPBACK.has(parsed.hostname)) return 'origin is not loopback';
  } catch {
    return 'origin header is not a valid URL';
  }
  return '';
}

/**
 * Mirror of the desktop host's own "is anything running?" check, so the button can
 * warn before it kills an in-flight turn. Reports known:false when the services are
 * shaped differently — a missing answer must never block the restart.
 */
function activeTasks(ctx) {
  try {
    const agents = ctx.get('agents');
    const jobs = ctx.get('jobs');
    if (!agents || typeof agents.list !== 'function') return { known: false, active: false };
    const runsJobs = (agent) =>
      typeof jobs?.list === 'function' &&
      (jobs.list(agent?.id) || []).some((job) => job?.status === 'running' || job?.status === 'stopping');
    const agents_ = agents.list() || [];
    const active =
      agents_.some(
        (agent) =>
          agent?.status === 'running' ||
          (agent?.inbox?.nextTurn?.length ?? 0) > 0 ||
          (agent?.inbox?.nextStep?.length ?? 0) > 0 ||
          runsJobs(agent),
      ) || runsJobs(undefined);
    return { known: true, active };
  } catch {
    return { known: false, active: false };
  }
}

/** Fork the detached helper with everything it needs to rebuild the app. */
function launchHelper(req) {
  const source = fileURLToPath(new URL('./helper.mjs', import.meta.url));
  const staged = path.join(os.tmpdir(), `dsh-quick-restart-${process.pid}.mjs`);
  fs.copyFileSync(source, staged);

  const payload = {
    pid: process.pid,
    ppid: process.ppid,
    execPath: process.execPath,
    imageName: path.basename(process.execPath || ''),
    argv: kind() === 'desktop' ? [] : process.argv.slice(1).filter((arg) => arg !== '--no-open'),
    cwd: process.cwd(),
    port: servingPort(req),
    kind: kind(),
  };

  const child = spawn(process.execPath, [staged], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    shell: false,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_QUICK_RESTART: JSON.stringify(payload) },
  });
  child.unref();
  return { helperPid: child.pid, log: path.join(os.tmpdir(), 'dsh-quick-restart.log') };
}

export function apply(ctx) {
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE,
        handler: async (req, res) => {
          const route = String(req.url || '').split('?')[0];

          if (route.endsWith('/status')) {
            const busy = activeTasks(ctx);
            return send(res, 200, {
              ok: true,
              plugin: name,
              kind: kind(),
              pid: process.pid,
              ppid: process.ppid,
              execPath: process.execPath,
              cwd: process.cwd(),
              port: servingPort(req),
              activeTasks: busy.active,
              tasksKnown: busy.known,
              restarting,
            });
          }

          if (!route.endsWith('/restart')) return send(res, 404, { ok: false, error: 'unknown route' });
          if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'restart requires POST' });
          if (String(req.headers[CSRF_HEADER] || '') !== '1') {
            return send(res, 403, { ok: false, error: `missing ${CSRF_HEADER} header` });
          }
          const problem = untrusted(req);
          if (problem) return send(res, 403, { ok: false, error: problem });
          if (restarting) return send(res, 409, { ok: false, error: 'restart already scheduled' });

          restarting = true;
          try {
            const launched = launchHelper(req);
            return send(res, 202, {
              ok: true,
              scheduled: true,
              helperPid: launched.helperPid,
              log: launched.log,
              note: 'the page will disappear while the app relaunches',
            });
          } catch (error) {
            restarting = false;
            return send(res, 500, { ok: false, error: String((error && error.message) || error) });
          }
        },
      }),
    'dsh-quick-restart: api',
  );
}
