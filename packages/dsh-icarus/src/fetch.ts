#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pythonProxyEnvironment } from './capabilities/proxy.js'

const localUvx = join(homedir(), '.local', 'bin', process.platform === 'win32' ? 'uvx.exe' : 'uvx')
const command = process.env.ICARUS_UVX ?? (existsSync(localUvx) ? localUvx : 'uvx')
const child = spawn(command, ['--from', 'mcp-server-fetch==2026.10.10', '--with', 'httpx[socks]==0.28.1', 'mcp-server-fetch', ...process.argv.slice(2)], {
  env: pythonProxyEnvironment(process.env), stdio: 'inherit', windowsHide: true,
})
process.on('SIGINT', () => child.kill('SIGINT'))
process.on('SIGTERM', () => child.kill('SIGTERM'))
process.exitCode = await new Promise<number>((resolve, reject) => {
  child.once('error', reject)
  child.once('exit', (code, signal) => code === null ? reject(new Error(`icarus: Fetch server terminated by ${signal}`)) : resolve(code))
})
