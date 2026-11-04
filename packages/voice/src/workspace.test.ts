// The workspace is named by what the project calls itself (workspace.ts identity()), never its folder: a Kortix
// project in /workspace was answered "security-tools", a sub-project's kortix.yaml, for "What is this project called?".
import { expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { identity, outline } from './workspace'

const project = (files: Record<string, string>) => {
  const dir = mkdtempSync(`${tmpdir()}/workspace-`)
  for (const [f, t] of Object.entries(files)) mkdirSync(`${dir}/${f}`.replace(/\/[^/]+$/, ''), { recursive: true }), writeFileSync(`${dir}/${f}`, t)
  return dir
}

test("a Kortix project: its README's title and kortix.yaml's project name, not a sub-project's", () => {
  const dir = project({
    'README.md': '# Kortix for Kortix\n\nThe company workforce.\n',
    'kortix.yaml': 'project:\n  name: company  # the slug\ndefault_agent: kortix\n',
    'security/kortix.yaml': 'project:\n  name: security-tools\n',
  })
  expect(identity(dir)).toBe('Kortix for Kortix (company)')
})

test('other manifests, and none', () => {
  expect(identity(project({ 'README.md': '# voice\n', 'package.json': '{"name":"voice"}' }))).toBe('voice')
  expect(identity(project({ 'pyproject.toml': '[build-system]\nname = "hatch"\n\n[project]\nname = "fastproj"\n' }))).toBe('fastproj')
  expect(identity(project({ 'go.mod': 'module github.com/acme/tool\n' }))).toBe('github.com/acme/tool')
  expect(identity(project({ 'notes.md': '# Notes\n' }))).toBe('')
})

test("what the router is told a Kortix project holds: its description, root folders and memory notes", () => {
  const dir = project({
    'kortix.yaml': 'project:\n  name: company\n  description: Kortix running Kortix\n',
    'memory/MEMORY.md': '# Memory\n',
    'memory/kortix-team.md': '# Team\n',
    'memory/deel-contractor-setup.md': '# Deel\n',
    'agents/kortix.md': '# Kortix\n',
    'skills/x/SKILL.md': '# x\n',
  })
  expect(outline(dir)).toEqual({ about: 'Kortix running Kortix', folders: 'agents, memory, skills', notes: 'deel-contractor-setup, kortix-team' })
  expect(outline(project({ 'notes.md': '# n\n' }))).toEqual({ about: '', folders: '', notes: '' })
})
