import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import semver from 'semver'
import { describe, expect, it } from 'vitest'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
  main?: string
  files?: string[]
  scripts?: { prepare?: string }
  exports: Record<string, unknown>
  dsh: { bundle: { patch: string }; client?: { entry?: string; platform?: string } }
}

describe('stock dsh plugin add', () => {
  it('declares dsh.bundle.patch so official add joins the profile layer stack', () => {
    expect(pkg.dsh.bundle.patch).toBe('./cordis.patch.yml')
    expect(existsSync(resolve(root, 'cordis.patch.yml'))).toBe(true)
    expect(pkg.files).toContain('cordis.patch.yml')
    const patch = readFileSync(resolve(root, 'cordis.patch.yml'), 'utf8')
    expect(patch).toContain('id: dsh-livevoice')
    expect(patch).toContain('name: dsh-livevoice')
    expect(patch).not.toContain('./src/')
  })

  it('commits compiled lib entries and does not require a prepare script', () => {
    expect(pkg.scripts?.prepare).toBeUndefined()
    expect(pkg.main).toBe('lib/dsh-livevoice.js')
    expect(pkg.dsh.client?.entry).toBe('./lib/client.js')
    expect(existsSync(resolve(root, 'lib/dsh-livevoice.js'))).toBe(true)
    expect(existsSync(resolve(root, 'lib/client.js'))).toBe(true)
    const host = readFileSync(resolve(root, 'lib/dsh-livevoice.js'), 'utf8')
    const client = readFileSync(resolve(root, 'lib/client.js'), 'utf8')
    expect(host).toMatch(/\bexport\b[\s\S]*\bapply\b/)
    expect(host).not.toMatch(/from ['"]\.\/.*\.ts['"]/)
    expect(client).toMatch(/^window\.__ModuleLoader__\.load\(\{/)
    expect(client).toContain('id: "dsh-livevoice"')
    expect(client).not.toMatch(/\/home\/|\/Users\/|\/agent\//)
  })

  it('accepts Harness 0.2.1-rc.2 and stable 0.2.1, and rejects alphas and 0.2.0-rc.2', () => {
    const peers = (pkg as { peerDependencies?: Record<string, string> }).peerDependencies ?? {}
    const engines = (pkg as { engines?: Record<string, string> }).engines ?? {}
    const dev = (pkg as { devDependencies?: Record<string, string> }).devDependencies ?? {}
    expect(engines.dsh).toBe('>=0.2.1-rc.1 <0.2.2')
    const peerNames = Object.keys(peers).filter(name => name.startsWith('@deepseek-ai/dsh-'))
    expect(peerNames.length).toBeGreaterThan(0)
    for (const name of peerNames) {
      expect(peers[name]).toBe('>=0.2.1-rc.1 <0.2.2')
      expect(semver.satisfies('0.2.1-rc.1', peers[name]!, { includePrerelease: true })).toBe(true)
      expect(semver.satisfies('0.2.1-rc.2', peers[name]!, { includePrerelease: true })).toBe(true)
      expect(semver.satisfies('0.2.1', peers[name]!)).toBe(true)
      expect(semver.satisfies('0.2.1-alpha.5', peers[name]!, { includePrerelease: true })).toBe(false)
      expect(semver.satisfies('0.2.0-rc.2', peers[name]!, { includePrerelease: true })).toBe(false)
      expect(semver.satisfies('0.2.0', peers[name]!)).toBe(false)
      expect(semver.satisfies('0.2.2', peers[name]!)).toBe(false)
    }
    expect(semver.satisfies('0.2.1-rc.2', engines.dsh!, { includePrerelease: true })).toBe(true)
    expect(semver.satisfies('0.2.0-rc.2', engines.dsh!, { includePrerelease: true })).toBe(false)
    const devNames = Object.keys(dev).filter(name => name.startsWith('@deepseek-ai/dsh-'))
    for (const name of devNames) expect(dev[name]).toBe('0.2.1-rc.2')
    const readme = readFileSync(resolve(root, 'README.md'), 'utf8')
    expect(readme).toContain('0.2.1-rc.2')
    expect(readme).toContain('stable `0.2.1`')
    expect(readme).toContain('@deepseek-ai/dsh@0.2.1-rc.2')
    expect(readme).toContain('dsh-v0.2.1-rc.2')
    expect(readme).toContain('687f282e8625c6b8d11ff58211a90524be2e4317')
    expect(readme).toContain('engines.dsh')
    expect(readme).toContain('>=0.2.1-rc.1 <0.2.2')
    expect(readme).not.toContain('639ed015397290b3745d163aafe02ffee4aa3f84')
    expect(readme).not.toContain('>=0.2.0-rc.1 <0.2.1')
    expect(readme).not.toContain('0.2.1-alpha.5')
  })

  it('leads the README with the official stock add and names pnpm', () => {
    const readme = readFileSync(resolve(root, 'README.md'), 'utf8')
    const fence = readme.match(/```sh\n([\s\S]*?)```/)
    expect(fence?.[1].trim()).toBe(
      'dsh plugin --profile web add dsh-livevoice@npm:@aa2246740/dsh-livevoice@0.1.6',
    )
    expect(readme).toMatch(/\*\*pnpm\*\*/)
    expect(readme).toMatch(/reopen that Host once and reload/i)
    expect(readme).not.toMatch(/activate-new-client|my-plugins|DSHX_HARNESS|dshx /)
  })
})
