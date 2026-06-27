import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const healthUrl = 'http://127.0.0.1:8787/health';

function loadFluffyPath() {
  if (process.env.LUNA_FLUFFY_PATH?.trim()) {
    return process.env.LUNA_FLUFFY_PATH.trim();
  }
  try {
    const envText = readFileSync(path.join(root, '.env'), 'utf8');
    const match = envText.match(/^LUNA_FLUFFY_PATH=(.+)$/m);
    if (match?.[1]) return match[1].trim();
  } catch {
    // ignore
  }
  return 'D:\\live2d model viewer';
}

const fluffyPath = loadFluffyPath();

function loadEnvValue(key) {
  if (process.env[key]?.trim()) return process.env[key].trim();
  try {
    const envText = readFileSync(path.join(root, '.env'), 'utf8');
    const match = envText.match(new RegExp(`^${key}=(.+)$`, 'm'));
    if (match?.[1]) return match[1].trim();
  } catch {
    // ignore
  }
  return '';
}

const live2dModel = loadEnvValue('LUNA_LIVE2D_MODEL')
  || path.join(fluffyPath, 'tuzi_mian__2_', 'tuzi mian.model3.json');
let backendChild = null;
let shuttingDown = false;

async function isUp(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2500) });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitFor(url, attempts = 45, delayMs = 2000) {
  for (let i = 0; i < attempts; i += 1) {
    if (await isUp(url)) return true;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return false;
}

function spawnBackend() {
  backendChild = spawn('npm', ['run', 'dev', '--workspace', '@giada/server'], {
    cwd: root,
    shell: true,
    stdio: 'inherit',
    env: process.env
  });
  return backendChild;
}

async function launchAvatar() {
  return new Promise((resolve, reject) => {
    const child = spawn('npm', ['run', 'app'], {
      cwd: fluffyPath,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        LUNA_SYNC: '1',
        ...(loadEnvValue('LUNA_TTS_VOLUME') ? { LUNA_TTS_VOLUME: loadEnvValue('LUNA_TTS_VOLUME') } : {}),
        ...(live2dModel ? { LUNA_LIVE2D_MODEL: live2dModel } : {})
      }
    });

    child.stdout?.on('data', (chunk) => process.stdout.write(chunk));
    child.stderr?.on('data', (chunk) => process.stderr.write(chunk));
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`Fluffy avatar failed to start (exit ${code ?? 'unknown'})`));
    });
  });
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (backendChild && !backendChild.killed) {
    backendChild.kill('SIGTERM');
  }
  process.exit(code);
}

process.on('SIGINT', () => {
  console.log('\nStopping Luna backend…');
  shutdown(0);
});

process.on('SIGTERM', () => shutdown(0));

async function main() {
  console.log('Luna (single terminal — backend logs stay here)\n');
  console.log('  Backend:  http://127.0.0.1:8787');
  console.log('  Monitor:  http://127.0.0.1:8787/monitor');
  console.log('  Avatar:   ' + fluffyPath);
  if (live2dModel) console.log('  Model:    ' + live2dModel);
  console.log('');

  const backendAlreadyRunning = await isUp(healthUrl);

  if (!backendAlreadyRunning) {
    console.log('Step 1/2: Starting Luna backend in this terminal…');
    spawnBackend();
    console.log('  Waiting for http://127.0.0.1:8787/health …');
    if (!(await waitFor(healthUrl))) {
      console.error('\nBackend did not become ready.');
      shutdown(1);
      return;
    }
    console.log('  Luna backend is ready.\n');
  } else {
    console.log('Step 1/2: Luna backend already running.\n');
  }

  console.log('Step 2/2: Launching Fluffy Live2D avatar (Electron window only)…');
  try {
    await launchAvatar();
    console.log('  Fluffy avatar is running and synced to Luna.\n');
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error('If it is already open, run in the fluffy folder: npm run app:stop');
    if (!backendAlreadyRunning) shutdown(1);
    return;
  }

  if (backendAlreadyRunning) {
    console.log('Done. Luna backend was already running in another process.');
    console.log('Close the Fluffy window with npm run app:stop in the fluffy folder.');
    return;
  }

  console.log('Luna is running. Press Ctrl+C here to stop the backend.');
  console.log('The bunny window stays open until you close it or run npm run app:stop.\n');

  await new Promise((resolve) => {
    backendChild?.on('exit', (code) => {
      if (!shuttingDown) {
        console.log(`\nLuna backend exited (${code ?? 0}).`);
      }
      resolve();
    });
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  shutdown(1);
});
