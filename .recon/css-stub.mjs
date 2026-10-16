// Node load hook for probes: CSS imports become an empty module.
import { registerHooks } from 'node:module'
registerHooks({
  load(url, context, next) {
    if (url.endsWith('.css')) return { format: 'module', source: 'export default {}', shortCircuit: true }
    return next(url, context)
  },
})
