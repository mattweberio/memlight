/**
 * Storage path resolution.
 *
 * memlight stores memory in the operating system's app-data directory,
 * not in a repo or the current working directory. A caller picks a
 * logical location with `name` (the app) and an optional `scope` (a
 * project), and memlight resolves that to a real path:
 *
 *   <os-data>/<name>/<scope>
 *
 * Layout by platform (os-data root):
 *   - Linux/other: $XDG_DATA_HOME or ~/.local/share
 *   - macOS:       ~/Library/Application Support
 *   - Windows:     %APPDATA% or ~/AppData/Roaming
 *
 * A caller that wants full control can pass an explicit `dataDir`,
 * which is used verbatim. The special value 'memory://' selects an
 * ephemeral in-memory database (used by tests).
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'

/** PGlite's in-memory database URI. Passed through untouched. */
export const IN_MEMORY = 'memory://'

/** The platform app-data root that every default path hangs off. */
export function osDataRoot(): string {
  if (process.platform === 'win32') {
    return process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support')
  }
  return process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share')
}

/** Where to resolve a memlight database for. */
export interface StorageLocation {
  /** Explicit path. Wins over name/scope. 'memory://' for ephemeral. */
  dataDir?: string
  /** App name. Defaults to 'memlight'. First path segment under os-data. */
  name?: string
  /** Optional project id. Second path segment, for per-project isolation. */
  scope?: string
}

/**
 * Resolve a {@link StorageLocation} to a concrete directory and create
 * it if needed. Returns 'memory://' untouched for the ephemeral case.
 */
export function resolveDataDir(loc: StorageLocation): string {
  if (loc.dataDir) {
    if (loc.dataDir === IN_MEMORY) return loc.dataDir
    mkdirSync(loc.dataDir, { recursive: true })
    return loc.dataDir
  }
  const segments = [osDataRoot(), sanitizeSegment(loc.name ?? 'memlight')]
  if (loc.scope) segments.push(sanitizeSegment(loc.scope))
  const dir = join(...segments)
  mkdirSync(dir, { recursive: true })
  return dir
}

/** Legacy cache directory used before the default model was bundled. */
export function modelCacheDir(): string {
  const dir = join(osDataRoot(), 'memlight', 'models')
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Make a single name/scope segment safe to use as a directory name.
 * A scope like 'mattweberio/homurai' becomes 'mattweberio-homurai'.
 */
function sanitizeSegment(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  if (!cleaned) {
    throw new Error(`memlight: storage segment ${JSON.stringify(value)} is empty after sanitizing`)
  }
  return cleaned
}
