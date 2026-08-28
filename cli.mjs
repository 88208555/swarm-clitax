#!/usr/bin/env node
import { dirname, resolve } from 'node:path'
import { stdin } from 'node:process'
import { fileURLToPath } from 'node:url'
import { dispatchOfficialSkillCli, runIntakeHandshake } from './installer.mjs'
import { executeCoordinatorOperation } from './swarm-coordinator.mjs'

const MAX_LOCAL_STDIN_BYTES = 1_048_576

const INTAKE_QUESTIONS = [
  {
    id: 'goal',
    prompt: 'What must the swarm accomplish? List the parallel/ordered work items or point to the project JSON.',
    required: true,
    example: '12 个模块迁移：A1..A12，依赖 A1→A2→A3，其余并行',
  },
  {
    id: 'workerCount',
    prompt: 'How many worker sub-agents should the brain create?',
    required: false,
    example: '6',
  },
  {
    id: 'orgTier',
    prompt: 'Any org-chart constraints? (default: board → dispatcher/ops/security-guard → workers)',
    required: false,
    example: '默认三层即可',
  },
  {
    id: 'securityPolicy',
    prompt: 'Security policy: strict (block injections) or observe (alert only)?',
    required: false,
    example: 'strict',
  },
]

async function readLocalInput() {
  const chunks = []
  let bytes = 0
  for await (const chunk of stdin) {
    bytes += chunk.length
    if (bytes > MAX_LOCAL_STDIN_BYTES) throw new Error('coordinator input exceeds 1 MiB')
    chunks.push(chunk)
  }
  const source = Buffer.concat(chunks).toString('utf8').trim()
  const input = source ? JSON.parse(source) : {}
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('coordinator input must be a JSON object')
  }
  return input
}

async function runLocalCoordinator(args) {
  const operation = args[0]?.trim()
  const repositoryRoot = args[1]?.trim()
  if (!operation || !repositoryRoot) throw new Error('usage: cli-swarm local <operation> <repositoryRoot>')
  return executeCoordinatorOperation(operation, repositoryRoot, await readLocalInput())
}

const cliPath = fileURLToPath(import.meta.url)
if (process.argv[1] && resolve(process.argv[1]) === cliPath && process.argv[2] === 'local') {
  try {
    console.log(JSON.stringify(await runLocalCoordinator(process.argv.slice(3))))
  } catch (error) {
    const code = error instanceof Error && typeof error.code === 'string'
      ? error.code : 'SWARM_COORD_FAILED'
    console.error(JSON.stringify({ status: 'failed', code,
      message: error instanceof Error ? error.message : String(error) }))
    process.exitCode = 1
  }
} else {
  await dispatchOfficialSkillCli({
    packageRoot: dirname(cliPath),
    runCommand: (context) => runIntakeHandshake(context, {
      questions: INTAKE_QUESTIONS,
      outputFile: 'SWARM-REQUIREMENTS.json',
      afterCapabilities(output) {
        const instruction = output.nextStep?.instruction
        if (typeof instruction === 'string' && instruction.trim()) console.log(instruction)
      },
    }),
  })
}

export { runLocalCoordinator }
