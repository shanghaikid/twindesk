import { registerHooks } from 'node:module'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier.startsWith('@deepseek-ai/') ||
      specifier === '@twindesk/harness-adapter' ||
      specifier.startsWith('@twindesk/harness-adapter/')
    ) {
      throw new Error(`Domain isolation violation: attempted to load ${specifier}`)
    }

    return nextResolve(specifier, context)
  },
})
