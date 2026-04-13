import test from 'node:test'
import assert from 'node:assert/strict'

import {
  isBetterStackEnvEnabled,
  isBetterStackLoggingEnabled,
  isBetterStackSentryEnabled,
} from './better-stack.ts'

test('Better Stack stays disabled for local web envs even with credentials present', () => {
  const env = {
    NEXT_PUBLIC_ENV_MODE: 'local',
    NEXT_PUBLIC_SENTRY_DSN: 'https://example@sentry.invalid/1',
    NEXT_PUBLIC_BETTER_STACK_SOURCE_TOKEN: 'token',
  }

  assert.equal(isBetterStackEnvEnabled(env), false)
  assert.equal(isBetterStackSentryEnabled(env), false)
  assert.equal(isBetterStackLoggingEnabled(env), false)
})

test('Better Stack enables for cloud web envs when credentials are present', () => {
  const env = {
    NEXT_PUBLIC_ENV_MODE: 'cloud',
    NEXT_PUBLIC_SENTRY_DSN: 'https://example@sentry.invalid/1',
    NEXT_PUBLIC_BETTER_STACK_SOURCE_TOKEN: 'token',
  }

  assert.equal(isBetterStackEnvEnabled(env), true)
  assert.equal(isBetterStackSentryEnabled(env), true)
  assert.equal(isBetterStackLoggingEnabled(env), true)
})

test('Better Stack enables for explicitly prod-like public envs', () => {
  const env = {
    NEXT_PUBLIC_ENV_MODE: 'local',
    NEXT_PUBLIC_KORTIX_ENV: 'staging',
    NEXT_PUBLIC_SENTRY_DSN: 'https://example@sentry.invalid/1',
  }

  assert.equal(isBetterStackEnvEnabled(env), true)
  assert.equal(isBetterStackSentryEnabled(env), true)
})

test('Better Stack stays enabled in cloud envs when credentials exist', () => {
  const env = {
    NEXT_PUBLIC_ENV_MODE: 'cloud',
    NEXT_PUBLIC_SENTRY_DSN: 'https://example@sentry.invalid/1',
    NEXT_PUBLIC_BETTER_STACK_SOURCE_TOKEN: 'token',
  }

  assert.equal(isBetterStackEnvEnabled(env), true)
  assert.equal(isBetterStackSentryEnabled(env), true)
  assert.equal(isBetterStackLoggingEnabled(env), true)
})
