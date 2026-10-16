
// Map two bare specifiers this isolated store cannot resolve. Everything else
// falls through to the real resolver, so the specs run against real source.
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'vitest') {
    return { url: new URL('./vitest-shim.mjs', import.meta.url).href, shortCircuit: true }
  }
  if (specifier === '@deepseek-ai/schemastery') {
    return { url: new URL('./schemastery-stub.mjs', import.meta.url).href, shortCircuit: true }
  }
  return nextResolve(specifier, context)
}
