import { clientBundle } from '../tsdown.client.ts'

// The host half carries a schema, so it is built in the Host pass: the node half then
// keeps `@deepseek-ai/schemastery` as an external import, the way every host package in
// the repository resolves it, instead of inlining the vendor tree into a client pass.
export default clientBundle('@deepseek-ai/dsh-client-ui-personalization', ['lib/types/index.js'], {
  hostPhase: true,
})
