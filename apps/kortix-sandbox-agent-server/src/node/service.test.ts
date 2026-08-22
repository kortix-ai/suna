import { describe, expect, test } from 'bun:test'
import { renderLaunchAgent, renderSystemdUnit, renderWindowsRunner, servicePaths } from './service'

describe('kortixd operating-system service definitions', () => {
  test('quotes an executable path in launchd XML', () => {
    const rendered = renderLaunchAgent('/Users/Test & User/kortixd', { KORTIXD_HOME: '/tmp/kortix state' })
    expect(rendered).toContain('/Users/Test &amp; User/kortixd')
    expect(rendered).toContain('<string>supervise</string>')
    expect(rendered).toContain('<key>SuccessfulExit</key><false/>')
  })

  test('quotes an executable path in the systemd command', () => {
    const rendered = renderSystemdUnit("/home/test user's/bin/kortixd", { KORTIXD_HOME: '/tmp/kortix state' })
    expect(rendered).toContain("ExecStart='/home/test user'\"'\"'s/bin/kortixd' supervise")
    expect(rendered).toContain('Restart=on-failure')
  })

  test('quotes an executable path in the Windows PowerShell runner', () => {
    const rendered = renderWindowsRunner("C:\\Users\\O'Brien\\kortixd.exe", { KORTIXD_HOME: 'C:\\Kortix State' })
    expect(rendered).toContain("& 'C:\\Users\\O''Brien\\kortixd.exe' 'supervise'")
  })

  test('keeps logs in the owner-controlled kortixd state directory', () => {
    const paths = servicePaths({ KORTIXD_HOME: '/private/kortixd' })
    expect(paths.stdout).toBe('/private/kortixd/kortixd.stdout.log')
    expect(paths.stderr).toBe('/private/kortixd/kortixd.stderr.log')
  })
})
