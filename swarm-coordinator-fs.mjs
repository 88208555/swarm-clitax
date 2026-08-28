import { generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import {
  appendFile,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { dirname, isAbsolute, posix, resolve, sep } from 'node:path'

const COORD_ROOT = '.coord'
const COORD_SCHEMA = 'swarm.coord-state/1.0'
const LEASE_SCHEMA = 'swarm.coord-lease/1.0'
const LOCK_WAIT_MS = 25
const LOCK_ATTEMPTS = 200
const STALE_STATE_LOCK_MS = 30_000

function coordinatorError(code, message) {
  const error = new Error(message)
  error.code = code
  throw error
}

function identifier(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    coordinatorError('SWARM_COORD_IDENTIFIER_INVALID', `${label} is invalid`)
  }
  return value
}

function relativePath(value, label = 'path') {
  if (typeof value !== 'string' || !value.trim() || isAbsolute(value) || value.includes('\\')) {
    coordinatorError('SWARM_COORD_PATH_INVALID', `${label} must be a repository-relative POSIX path`)
  }
  const normalized = posix.normalize(value.trim()).replace(/^\.\//, '').replace(/\/$/, '')
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    coordinatorError('SWARM_COORD_PATH_INVALID', `${label} escapes the repository`)
  }
  return normalized
}

async function exists(path) {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (error instanceof Error && error.code === 'ENOENT') return false
    throw error
  }
}

async function repositoryRoot(value) {
  if (typeof value !== 'string' || !value.trim()) {
    coordinatorError('SWARM_COORD_ROOT_REQUIRED', 'repositoryRoot is required')
  }
  const root = await realpath(resolve(value))
  const status = await lstat(root)
  if (!status.isDirectory() || status.isSymbolicLink()) {
    coordinatorError('SWARM_COORD_ROOT_INVALID', 'repositoryRoot must be a real directory')
  }
  return root
}

async function ensureDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 })
  const status = await lstat(path)
  if (!status.isDirectory() || status.isSymbolicLink()) {
    coordinatorError('SWARM_COORD_STORAGE_INVALID', `${path} must be a real directory`)
  }
  return path
}

async function ensureCoordDirectory(root, ...parts) {
  let current = resolve(root, COORD_ROOT)
  await ensureDirectory(current)
  for (const part of parts) {
    identifier(part, 'storage segment')
    current = resolve(current, part)
    await ensureDirectory(current)
  }
  return current
}

function emptyState(now) {
  return {
    schemaVersion: COORD_SCHEMA,
    revision: 0,
    tasks: [],
    locks: [],
    queue: [],
    waits: [],
    messages: [],
    events: [],
    decisions: [],
    timeoutCounts: [],
    updatedAt: now,
  }
}

function validateState(state) {
  const arrays = ['tasks', 'locks', 'queue', 'waits', 'messages', 'events', 'decisions', 'timeoutCounts']
  if (!state || state.schemaVersion !== COORD_SCHEMA || !Number.isSafeInteger(state.revision)
    || arrays.some((key) => !Array.isArray(state[key]))) {
    coordinatorError('SWARM_COORD_STATE_INVALID', 'coordination state is invalid')
  }
  return state
}

async function atomicJson(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { flag: 'wx', mode: 0o600 })
  await rename(temporary, path)
}

async function acquireStateLock(root) {
  const directory = await ensureCoordDirectory(root)
  const lockPath = resolve(directory, 'state.lock')
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
    try {
      const handle = await open(lockPath, 'wx', 0o600)
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() })}\n`)
      await handle.close()
      return lockPath
    } catch (error) {
      if (!(error instanceof Error && error.code === 'EEXIST')) throw error
      const status = await lstat(lockPath)
      if (Date.now() - status.mtimeMs > STALE_STATE_LOCK_MS) {
        await unlink(lockPath)
        continue
      }
      await new Promise((accept) => setTimeout(accept, LOCK_WAIT_MS))
    }
  }
  coordinatorError('SWARM_COORD_STATE_BUSY', 'coordination state lock timed out')
}

async function loadState(root, initialize) {
  const statePath = resolve(root, COORD_ROOT, 'state.json')
  try {
    return { path: statePath, state: validateState(JSON.parse(await readFile(statePath, 'utf8'))) }
  } catch (error) {
    if (!(error instanceof Error && error.code === 'ENOENT')) throw error
    if (!initialize) coordinatorError('SWARM_COORD_NOT_INITIALIZED', 'coordination state is not initialized')
    return { path: statePath, state: emptyState(new Date().toISOString()) }
  }
}

async function appendAudit(root, records) {
  if (!records.length) return
  const directory = await ensureCoordDirectory(root)
  const lines = records.map((record) => JSON.stringify({ ...record, recordedAt: new Date().toISOString() }))
  await appendFile(resolve(directory, 'audit.jsonl'), `${lines.join('\n')}\n`, { mode: 0o600 })
}

async function withCoordinationState(repositoryRootValue, mutate) {
  const root = await repositoryRoot(repositoryRootValue)
  const lockPath = await acquireStateLock(root)
  try {
    const authority = await loadState(root, true)
    const result = await mutate(authority.state, root)
    const state = validateState(result.state)
    state.revision += 1
    state.updatedAt = new Date().toISOString()
    await atomicJson(authority.path, state)
    await appendAudit(root, result.audit ?? [])
    return { ...result.output, revision: state.revision }
  } finally {
    await unlink(lockPath)
  }
}

async function readCoordinationState(repositoryRootValue) {
  const root = await repositoryRoot(repositoryRootValue)
  return (await loadState(root, false)).state
}

async function withCoordinationReadLock(repositoryRootValue, inspect) {
  const root = await repositoryRoot(repositoryRootValue)
  const lockPath = await acquireStateLock(root)
  try {
    return await inspect((await loadState(root, false)).state, root)
  } finally {
    await unlink(lockPath)
  }
}

function leasePayload(lease) {
  return {
    schemaVersion: lease.schemaVersion,
    leaseId: lease.leaseId,
    lockId: lease.lockId,
    chainId: lease.chainId,
    agentId: lease.agentId,
    lockType: lease.lockType,
    resource: lease.resource,
    paths: lease.paths,
    issuedAt: lease.issuedAt,
    expiresAt: lease.expiresAt,
    authorityKeyId: lease.authorityKeyId,
    nonce: lease.nonce,
  }
}

async function authorityKeys(root) {
  const directory = await ensureCoordDirectory(root, 'authority')
  const privatePath = resolve(directory, 'private.pem')
  const publicPath = resolve(directory, 'public.pem')
  const privateExists = await exists(privatePath)
  const publicExists = await exists(publicPath)
  if (privateExists !== publicExists) {
    coordinatorError('SWARM_COORD_AUTHORITY_INVALID', 'coordination authority is incomplete')
  }
  if (!privateExists) {
    const pair = generateKeyPairSync('ed25519', {
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    })
    await writeFile(privatePath, pair.privateKey, { flag: 'wx', mode: 0o600 })
    await writeFile(publicPath, pair.publicKey, { flag: 'wx', mode: 0o600 })
  }
  for (const path of [privatePath, publicPath]) {
    const status = await lstat(path)
    if (!status.isFile() || status.isSymbolicLink()) {
      coordinatorError('SWARM_COORD_AUTHORITY_INVALID', 'coordination keys must be regular files')
    }
  }
  return { privateKey: await readFile(privatePath, 'utf8'), publicKey: await readFile(publicPath, 'utf8') }
}

async function writeSignedLease(root, unsignedLease, sha256) {
  const authority = await authorityKeys(root)
  const lease = { ...unsignedLease, schemaVersion: LEASE_SCHEMA, authorityKeyId: sha256(authority.publicKey) }
  const signature = sign(null, Buffer.from(JSON.stringify(leasePayload(lease))), authority.privateKey)
    .toString('base64url')
  const signedLease = { ...lease, signature }
  const directory = await ensureCoordDirectory(root, 'leases')
  const leasePath = resolve(directory, `${lease.leaseId}.json`)
  await writeFile(leasePath, `${JSON.stringify(signedLease)}\n`, { flag: 'wx', mode: 0o600 })
  return { signedLease, leasePath, relativeLeasePath: `${COORD_ROOT}/leases/${lease.leaseId}.json` }
}

function insideRepository(root, target) {
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`
  return target === root || target.startsWith(prefix)
}

export {
  COORD_ROOT,
  COORD_SCHEMA,
  LEASE_SCHEMA,
  coordinatorError,
  identifier,
  insideRepository,
  leasePayload,
  readCoordinationState,
  relativePath,
  repositoryRoot,
  withCoordinationState,
  withCoordinationReadLock,
  writeSignedLease,
}
