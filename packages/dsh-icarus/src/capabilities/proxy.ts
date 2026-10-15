import { isIP } from 'node:net'

export function pythonProxyEnvironment(environment: Record<string, string | undefined>): Record<string, string | undefined> {
  const bypass = environment.no_proxy ?? environment.NO_PROXY ?? ''
  const hosts = [...new Set([...bypass.split(',').map(host => host.trim()).filter(Boolean), 'localhost', '127.0.0.1', '::1']
    .map(host => host.startsWith('[') && host.endsWith(']') && isIP(host.slice(1, -1)) === 6 ? host.slice(1, -1) : host))]
  return { ...environment, NO_PROXY: hosts.join(','), no_proxy: hosts.join(',') }
}
