// Artifact files: the second store next to the database (M2.1 contract).
//
// Every ref in the database is a path relative to `artifactsDir`; nothing here writes
// outside it. Deliverable bodies and raw error records live here, the database keeps the
// reference plus the fingerprint.
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import type { IcarusPaths } from '../storage/index.js'

/** Relative ref of an artifact, always with `/` separators so it survives a move. */
export function artifactRef(...segments: readonly string[]): string {
  return segments.join('/')
}

/** Absolute path of a ref that resolves inside `artifactsDir`. */
export function artifactPathOf(paths: IcarusPaths, ref: string): string {
  const root = resolve(paths.artifactsDir)
  const target = resolve(root, ref)
  if (!target.startsWith(root + sep)) throw new Error(`icarus: artifact ref ${JSON.stringify(ref)} escapes ${root}`)
  return target
}

/** Write an artifact and return its relative ref. */
export function writeArtifact(paths: IcarusPaths, ref: string, content: string): string {
  const target = artifactPathOf(paths, ref)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, content)
  return ref
}

export function readArtifact(paths: IcarusPaths, ref: string): string {
  return readFileSync(artifactPathOf(paths, ref), 'utf8')
}

/** sha256 fingerprint of a deliverable body, stored next to its summary. */
export function contentHash(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/** Absolute path shown to a reader when a message points at its full record. */
export function absoluteArtifactPath(paths: IcarusPaths, ref: string): string {
  return join(paths.artifactsDir, ...ref.split('/'))
}
