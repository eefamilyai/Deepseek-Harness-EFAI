// Patch the installed Desktop application so a launch can select the profile it
// boots. Extracts app.asar, applies two exact replacements, repacks to
// app.asar.new, and verifies that nothing else changed.
//
// Usage: node .recon/patch-desktop-asar.mjs <resourcesDir>
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const resources = process.argv[2] ?? 'D:\\Deepseek-Desktop\\resources'
const archive = join(resources, 'app.asar')
const work = join(resources, '..', '.asar-patch-work')
const tree = join(work, 'tree')
const asarEntry = 'D:\\deepseek-kernel-harness\\node_modules\\@electron\\asar\\bin\\asar.js'

/** Run the asar CLI through Node; a `.cmd` shim cannot be spawned without a shell. */
function runAsar(args) {
  execFileSync(process.execPath, [asarEntry, ...args], { stdio: 'inherit' })
}

/** Replace exactly one occurrence, or fail loudly with the text that was there. */
function replaceOnce(file, before, after, label) {
  const source = readFileSync(file, 'utf8')
  const first = source.indexOf(before)
  if (first === -1) throw new Error(`${label}: the text to replace is not in ${file}`)
  if (source.indexOf(before, first + 1) !== -1) throw new Error(`${label}: the text to replace appears twice in ${file}`)
  writeFileSync(file, `${source.slice(0, first)}${after}${source.slice(first + before.length)}`)
  console.log(`patched ${label}`)
}

if (!existsSync(archive)) throw new Error(`no archive at ${archive}`)
rmSync(work, { recursive: true, force: true })
mkdirSync(tree, { recursive: true })
console.log(`extracting ${archive} (${(statSync(archive).size / 1024 / 1024).toFixed(1)} MB)`)
execFileSync(process.execPath, [asarEntry, 'extract', archive, tree], { stdio: 'inherit' })

// 1. The shell resolves the profile it owns from the launch environment.
replaceOnce(join(tree, 'lib', 'main.js'),
  `function resolveDesktopPaths(dshHome = resolveDshHome()) {
	return {
		profile: join(dshHome, "profiles", "desktop"),
		lock: join(dshHome, "profiles", "desktop", "lock")
	};
}`,
  `function desktopProfileName(environment = process.env) {
	const requested = environment.DSH_DESKTOP_PROFILE?.trim();
	return requested === void 0 || requested === "" ? "desktop" : requested;
}
function resolveDesktopPaths(dshHome = resolveDshHome(), profile = desktopProfileName()) {
	return {
		profile: join(dshHome, "profiles", profile),
		lock: join(dshHome, "profiles", profile, "lock")
	};
}`, 'lib/main.js')

// 2. The Host boots that profile by name, on a port a second window can own.
replaceOnce(join(tree, 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'index.js'),
  `	const application = runProfile({
		environment: loadLayeredEnv("dsh"),
		profile: "desktop",`,
  `	const selectedProfile = process.env.DSH_DESKTOP_PROFILE?.trim();
	const profileName = selectedProfile === void 0 || selectedProfile === "" ? "desktop" : selectedProfile;
	const application = runProfile({
		environment: loadLayeredEnv("dsh"),
		profile: profileName,`, 'desktop-host profile name')

replaceOnce(join(tree, 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'index.js'),
  `		args: [
			"--no-open",
			"--port",
			"19387"
		],`,
  `		args: [
			"--no-open",
			"--port",
			profileName === "desktop" ? "19387" : "0"
		],`, 'desktop-host port')

const output = join(resources, 'app.asar.new')
rmSync(output, { force: true })
console.log('packing app.asar.new')
runAsar(['pack', tree, output])
console.log(`packed ${(statSync(output).size / 1024 / 1024).toFixed(1)} MB -> ${output}`)
