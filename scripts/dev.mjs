// Development: start Vite, wait until it answers, then start Electron pointed at it.
import { spawn } from 'node:child_process';
import http from 'node:http';

const url = 'http://127.0.0.1:5173';
const shell = process.platform === 'win32';
const vite = spawn('npx', ['vite'], { stdio: 'inherit', shell });
const wait = () => new Promise((resolve) => {
  const tick = () => http.get(url, (res) => { res.resume(); resolve(); }).on('error', () => setTimeout(tick, 300));
  tick();
});
await wait();
const electron = spawn('npx', ['electron', '.'], { stdio: 'inherit', shell, env: { ...process.env, ELECTRON_START_URL: url } });
const stop = () => { vite.kill(); electron.kill(); };
electron.on('exit', () => { vite.kill(); process.exit(0); });
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
