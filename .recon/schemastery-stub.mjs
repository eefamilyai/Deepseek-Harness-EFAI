
// Stand-in for the schemastery default export. The reader package uses it only
// for plugin Config schemas, which no spec here exercises, so a self-returning
// chainable proxy is enough to let the module graph load. A Proxy (not a fixed
// method list) is what keeps this from having to mirror their whole API.
const make = () => new Proxy(function () {}, {
  get: (_t, key) => {
    if (key === 'toString') return () => '[schemastery-stub]'
    if (key === Symbol.toPrimitive) return () => '[schemastery-stub]'
    if (key === 'then') return undefined
    return make()
  },
  apply: () => make(),
  construct: () => make(),
})
const z = make()
export default z
