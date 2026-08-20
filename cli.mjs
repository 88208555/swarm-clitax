#!/usr/bin/env node
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dispatchOfficialSkillCli, runIntakeHandshake } from './installer.mjs'

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

await dispatchOfficialSkillCli({
  packageRoot: dirname(fileURLToPath(import.meta.url)),
  runCommand: (context) => runIntakeHandshake(context, {
    questions: INTAKE_QUESTIONS,
    outputFile: 'SWARM-REQUIREMENTS.json',
    afterCapabilities(output) {
      const instruction = output.nextStep?.instruction
      if (typeof instruction === 'string' && instruction.trim()) console.log(instruction)
    },
  }),
})
