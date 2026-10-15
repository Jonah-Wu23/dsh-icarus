import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import browser from '@anweat/dsh-browser'

export const name = 'icarus-browser'
export const inject = browser.inject
export const Config = browser.Config

export function findInstalledChromium(): string | undefined {
  const home = homedir()
  const caches = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    process.env.LOCALAPPDATA === undefined ? undefined : join(process.env.LOCALAPPDATA, 'ms-playwright'),
    join(home, '.cache', 'ms-playwright'),
    join(home, 'Library', 'Caches', 'ms-playwright'),
  ]
  const executables = ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe', 'chrome-linux64/chrome', 'chrome-linux/chrome',
    'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing']
  for (const cache of new Set(caches)) {
    if (cache === undefined || cache === '0' || !existsSync(cache)) continue
    const versions = readdirSync(cache).filter(entry => entry.startsWith('chromium-'))
      .sort((left, right) => Number(right.slice('chromium-'.length)) - Number(left.slice('chromium-'.length)))
    for (const version of versions) for (const executable of executables) {
      const candidate = join(cache, version, executable)
      if (existsSync(candidate)) return candidate
    }
  }
  const candidates = [
    ...[process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA]
      .filter((directory): directory is string => directory !== undefined)
      .flatMap(directory => [join(directory, 'Google/Chrome/Application/chrome.exe'), join(directory, 'Microsoft/Edge/Application/msedge.exe')]),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/opt/google/chrome/chrome',
  ]
  return candidates.find(candidate => existsSync(candidate))
}

export function apply(ctx: Parameters<typeof browser.apply>[0], config: Parameters<typeof browser.apply>[1]): void {
  const plain = (value: unknown): unknown => typeof value === 'object' && value !== null && Symbol.for('cosmokit.volatile.write') in value
    ? (value as { get(): unknown }).get() : value
  if (plain(config.enabled) === false) return
  const configuredPath = plain(config.executablePath)
  const channel = plain(config.channel)
  const discover = channel === undefined || channel === 'chromium'
  const executablePath = typeof configuredPath === 'string' && configuredPath !== '' ? configuredPath : discover ? findInstalledChromium() : undefined
  const configuredArgs = plain(config.args)
  const args: string[] = Array.isArray(configuredArgs) ? configuredArgs.map(String) : []
  const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy ?? process.env.ALL_PROXY ?? process.env.all_proxy
  if (proxy && !args.some(argument => argument.startsWith('--proxy-server='))) {
    const url = new URL(proxy)
    if (url.username || url.password) throw new Error('icarus: Chromium requires a local VPN proxy without URL credentials')
    const protocol = ['socks:', 'socks5h:'].includes(url.protocol) ? 'socks5:' : url.protocol
    if (!['http:', 'https:', 'socks4:', 'socks5:'].includes(protocol)) throw new TypeError('icarus: unsupported Chromium proxy protocol')
    args.push(`--proxy-server=${protocol}//${url.host}`)
    const bypass = process.env.NO_PROXY ?? process.env.no_proxy
    if (bypass) args.push(`--proxy-bypass-list=${bypass.split(',').map(host => host.trim()).filter(Boolean).join(';')}`)
  }
  browser.apply(ctx, { ...config, args, ...(executablePath === undefined ? {} : { executablePath }), autoInstall: discover && executablePath === undefined })
}

export default { name, inject, Config, apply }
