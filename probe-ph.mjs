
await import('@deepseek-ai/dsh-app-boot')
const ob = await import('@deepseek-ai/dsh-official-bundles')
console.log('after app-boot first:', typeof ob.PROFILE_TEMPLATES)
const ph = await import('./packages/boot/profile-hub/src/index.ts')
console.log('profile-hub loaded:', typeof ph)
