import { mkdtemp, mkdir, readdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  deleteSavedWorkflow, discoverWorkflowCatalog, loadWorkflowByName, renameSavedWorkflow,
  saveWorkflowCapsule, type WorkflowCatalogOptions,
} from '../src/catalog.js'
import { createWorkflowCapsule, validateWorkflowManifest } from '../src/capsule.js'

function capsule(name: string, description: string) {
  return createWorkflowCapsule({
    minDshVersion: '0.0.1-rc.2',
    manifest: validateWorkflowManifest({ name, description, phases: ['run'], readOnly: true, maxAgents: 2, maxConcurrency: 2, patterns: ['fan-out-and-synthesize'] }),
    source: 'async function run(wf, args) { return await wf.runAgent({ name: "worker", prompt: String(args.request), readOnly: true }); }',
  })
}

async function fixture(): Promise<WorkflowCatalogOptions> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-workflow-catalog-'))
  const project = join(root, 'project')
  const personal = join(root, 'personal')
  await mkdir(project)
  await mkdir(personal)
  return { project, personal, maxCapsuleBytes: 64_000, maxEntries: 20, maxAgents: 8, maxConcurrency: 4 }
}

describe('workflow discovery and saved lifecycle', () => {
  it('uses capsule-over-source and project-over-personal priority deterministically', async () => {
    const options = await fixture()
    await writeFile(join(options.personal, 'shared.workflow.json'), JSON.stringify(capsule('shared', 'personal')))
    await writeFile(join(options.personal, 'zeta.workflow.json'), JSON.stringify(capsule('zeta', 'zeta')))
    await writeFile(join(options.project, 'shared.js'), 'export default { meta: {}, run: async () => 1 }')
    await writeFile(join(options.project, 'shared.workflow.json'), JSON.stringify(capsule('shared', 'project')))
    await writeFile(join(options.project, 'alpha.workflow.json'), JSON.stringify(capsule('alpha', 'alpha')))
    const catalog = await discoverWorkflowCatalog(options)
    expect(catalog.entries.map(item => [item.name, item.source, item.execution, item.valid])).toEqual([
      ['alpha', 'project', 'capability-generated', true],
      ['shared', 'project', 'capability-generated', true],
      ['zeta', 'personal', 'capability-generated', true],
    ])
    expect((await loadWorkflowByName(options, 'shared')).capsule?.manifest.description).toBe('project')
  })

  it('reports malformed and oversized entries without hiding healthy workflows', async () => {
    const options = { ...await fixture(), maxCapsuleBytes: 400 }
    await writeFile(join(options.project, 'bad.workflow.json'), '{ nope')
    await writeFile(join(options.project, 'large.workflow.json'), 'x'.repeat(401))
    await writeFile(join(options.project, 'good.workflow.json'), JSON.stringify(capsule('good', 'ok')))
    const catalog = await discoverWorkflowCatalog(options)
    expect(catalog.entries.find(item => item.name === 'bad')).toMatchObject({ valid: false })
    expect(catalog.entries.find(item => item.name === 'large')).toMatchObject({ valid: false, error: expect.stringContaining('exceeds 400 bytes') })
    expect(catalog.entries.find(item => item.name === 'good')).toMatchObject({ valid: true })
  })

  it('requires approval before trusted-local import', async () => {
    const options = await fixture()
    await writeFile(join(options.project, 'trusted.mjs'), `export default { meta: { name: 'trusted', description: 'local', readOnly: true, phases: ['run'], maxAgents: 1, maxConcurrency: 1, patterns: ['classify-and-act'] }, run: async () => 'ok' }`)
    await expect(loadWorkflowByName(options, 'trusted')).rejects.toThrow(/requires explicit approval/u)
    const loaded = await loadWorkflowByName(options, 'trusted', true)
    expect(await loaded.module.run?.({} as never, {})).toBe('ok')
  })

  it('loads approved TypeScript modules through the Node 22 type-stripping runtime', async () => {
    const options = await fixture()
    await writeFile(join(options.project, 'typed.ts'), `
      interface Args { value: string }
      export default {
        meta: { name: 'typed', description: 'typed local', readOnly: true, phases: ['run'], maxAgents: 1, maxConcurrency: 1, patterns: ['classify-and-act'] },
        run: async (_wf: unknown, args: Args) => args.value,
      }
    `)
    const loaded = await loadWorkflowByName(options, 'typed', true)
    expect(await loaded.module.run?.({} as never, { value: 'typed-ok' })).toBe('typed-ok')
  })

  it('saves atomically, archives replacement, renames, and deletes within the catalog root', async () => {
    const options = await fixture()
    await saveWorkflowCapsule(options.project, 'first', capsule('first', 'v1'))
    await expect(saveWorkflowCapsule(options.project, 'first', capsule('first', 'v2'))).rejects.toThrow(/already exists/u)
    await saveWorkflowCapsule(options.project, 'first', capsule('first', 'v2'), true)
    await renameSavedWorkflow(options.project, 'first', 'second')
    expect((await loadWorkflowByName(options, 'second')).capsule?.manifest.description).toBe('v2')
    await deleteSavedWorkflow(options.project, 'second')
    await expect(loadWorkflowByName(options, 'second')).rejects.toThrow(/not found/u)
    await expect(deleteSavedWorkflow(options.project, '../escape')).rejects.toThrow(/invalid workflow name/u)
  })

  it('allows exactly one winner when 20 replace=false saves race for the same target', async () => {
    const options = await fixture()
    const attempts = await Promise.allSettled(Array.from(
      { length: 20 },
      () => saveWorkflowCapsule(options.project, 'contended', capsule('contended', 'winner')),
    ))
    expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const failures = attempts.filter(result => result.status === 'rejected')
    expect(failures).toHaveLength(19)
    for (const failure of failures) {
      if (failure.status === 'rejected') expect(String(failure.reason)).toMatch(/already exists/u)
    }
    expect((await loadWorkflowByName(options, 'contended')).capsule?.manifest.description).toBe('winner')
  })

  it('rejects a catalog root or archive directory that is a junction or symbolic link', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-workflow-junction-'))
    const outside = join(root, 'outside')
    const linkedCatalog = join(root, 'linked-catalog')
    await mkdir(outside)
    await symlink(outside, linkedCatalog, process.platform === 'win32' ? 'junction' : 'dir')

    await expect(saveWorkflowCapsule(linkedCatalog, 'escaped', capsule('escaped', 'no')))
      .rejects.toThrow(/symbolic link|reparse point/u)
    expect(await readdir(outside)).toEqual([])
    await writeFile(join(outside, 'escaped.workflow.json'), JSON.stringify(capsule('escaped', 'outside')))
    await expect(renameSavedWorkflow(linkedCatalog, 'escaped', 'renamed'))
      .rejects.toThrow(/symbolic link|reparse point/u)
    await expect(deleteSavedWorkflow(linkedCatalog, 'escaped'))
      .rejects.toThrow(/symbolic link|reparse point/u)
    expect(await readdir(outside)).toEqual(['escaped.workflow.json'])

    const catalog = join(root, 'catalog')
    const archiveOutside = join(root, 'archive-outside')
    await mkdir(catalog)
    await mkdir(archiveOutside)
    await saveWorkflowCapsule(catalog, 'safe', capsule('safe', 'v1'))
    await symlink(archiveOutside, join(catalog, '.archive'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(saveWorkflowCapsule(catalog, 'safe', capsule('safe', 'v2'), true))
      .rejects.toThrow(/symbolic link|reparse point/u)
    expect(await readdir(archiveOutside)).toEqual([])
  })
})
