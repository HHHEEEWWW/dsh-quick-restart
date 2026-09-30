/**
 * dsh-quick-restart helper.
 *
 * Forked detached by the host with ELECTRON_RUN_AS_NODE=1, so it outlives both the
 * host and the Electron main process that owns it. Its only job: make sure the old
 * process tree is really gone, then start the application again.
 *
 * Payload arrives as JSON in DSH_QUICK_RESTART.
 *
 * Teardown rules that matter here:
 *   - Never `taskkill /T` the Electron main pid. This helper was forked *from* that
 *     tree (main -> host -> helper), so a recursive kill would take out the process
 *     that is supposed to relaunch the app.
 *   - A plain `taskkill /F /PID <main>` orphans the host, renderers and GPU children
 *     instead of killing them, so those are collected afterwards by image name —
 *     always excluding this helper's own pid. `taskkill /IM` cannot exclude a pid,
 *     which is why the sweep parses `tasklist` and kills one pid at a time.
 */
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const { pid, ppid, execPath, imageName, cwd, port, argv, kind } = JSON.parse(
  process.env.DSH_QUICK_RESTART || '{}',
);
const isDesktop = kind === 'desktop';
const LOG = path.join(os.tmpdir(), 'dsh-quick-restart.log');
const SELF = process.pid;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function log(line) {
  try {
    fs.appendFileSync(LOG, `[${new Date().toISOString()}] ${line}\n`);
  } catch {}
}

function run(file, args) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true }, (error, stdout) => resolve(String(stdout || '')));
  });
}

const alive = (target) => {
  try {
    process.kill(target, 0);
    return true;
  } catch {
    return false;
  }
};

/** Poll `done` until it reports true or the budget runs out. */
async function until(done, tries, gap) {
  for (let i = 0; i < tries; i += 1) {
    if (await done()) return true;
    await sleep(gap);
  }
  return false;
}

/** Resolving a promise twice is a no-op, so the first event wins. */
function portOpen(target) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port: target });
    socket.setTimeout(1000, () => socket.destroy());
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
    socket.once('close', () => resolve(false));
  });
}

/** Kill one pid without touching its children. */
async function killPid(target, note) {
  if (!target || !alive(target)) return;
  log(`taskkill /F /PID ${target}${note ? ` (${note})` : ''}`);
  await run('taskkill', ['/F', '/PID', String(target)]);
}

/**
 * Sweep every remaining process sharing the app's image name, skipping this helper —
 * it runs from the same executable and would otherwise delete itself before it can
 * bring the app back.
 */
async function killByImage(image) {
  if (!image) return 0;
  const listed = await run('tasklist', ['/FI', `IMAGENAME eq ${image}`, '/FO', 'CSV', '/NH']);
  if (/no tasks|没有运行的任务/i.test(listed)) {
    log(`image sweep: no ${image} left`);
    return 0;
  }
  const victims = listed
    .split(/\r?\n/)
    .map((line) => line.match(/^"([^"]*)","(\d+)"/))
    .filter((match) => match && Number(match[2]) !== SELF)
    .map((match) => Number(match[2]));
  for (const victim of victims) {
    log(`taskkill /F /PID ${victim} (image sweep ${image})`);
    await run('taskkill', ['/F', '/PID', String(victim)]);
  }
  return victims.length;
}

/** The relaunched GUI must not inherit electron-as-node markers. */
function relaunchEnv() {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ATTACH_CONSOLE', 'DSH_QUICK_RESTART']) {
    delete env[key];
  }
  return env;
}

async function main() {
  log(`helper start pid=${SELF} host=${pid} app=${ppid} exe=${execPath} port=${port}`);

  // Let the host flush the 202 that spawned us before its tree starts dying.
  await sleep(400);

  if (isDesktop) {
    // Kill the Electron main process only. No /T: recursion would reach this helper.
    await killPid(ppid, 'electron main');

    // The host notices the broken IPC channel and stops on its own; give it room.
    const gone = await until(() => !alive(pid), 20, 150);
    log(`host ${pid} gone=${gone}`);
    if (!gone) await killPid(pid, 'host');

    log(`image sweep killed ${await killByImage(imageName)}`);
  } else {
    // Plain `dsh web`: the parent is the user's shell and the image name is a shared
    // node binary, so neither the parent nor an image sweep is allowed here.
    await killPid(pid, 'host');
    log('web surface: parent shell and image sweep left alone');
  }

  if (port) {
    const closed = await until(async () => !(await portOpen(port)), 40, 250);
    log(`port ${port} released=${closed}`);
  }
  await sleep(1200);

  if (!execPath || !fs.existsSync(execPath)) {
    log(`relaunch aborted: executable missing (${execPath})`);
    process.exit(1);
  }

  const child = spawn(execPath, Array.isArray(argv) ? argv : [], {
    detached: true,
    stdio: 'ignore',
    cwd: cwd || path.dirname(execPath),
    env: relaunchEnv(),
  });
  child.unref();
  log(`relaunched pid=${child.pid}`);

  await sleep(600);
  try {
    fs.rmSync(process.argv[1], { force: true });
  } catch {}
  process.exit(0);
}

main().catch((error) => {
  log(`helper failed: ${(error && error.stack) || error}`);
  process.exit(1);
});
