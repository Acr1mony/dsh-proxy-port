/**
 * The persisted half: what `/proxy` writes so the next start begins where the
 * last one ended.
 *
 * The row config (`cordis.patch.yml`) stays the shipped default; this file is
 * the user's own answer, written by the command surface rather than by hand.
 * It overrides the row config and nothing else reads it.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** File name inside the profile directory. */
const FILENAME = 'local-proxy.json';

/**
 * The active profile directory.
 *
 * `profileContext` is DSH's own answer and is authoritative whenever the host
 * provides it; the environment fallback covers a bare host without that service.
 *
 * @param ctx - the plugin context.
 * @returns an absolute directory path.
 */
export function profileDirectory(ctx) {
	try {
		const profile = ctx?.get?.('profileContext');
		if (profile !== null && typeof profile === 'object' && typeof profile.dir === 'string' && profile.dir !== '') return profile.dir;
	} catch {
		/* fall through to the environment */
	}
	const home = process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : path.join(os.homedir(), '.dsh');
	const profile = process.env.DSH_PROFILE !== undefined && process.env.DSH_PROFILE !== '' ? process.env.DSH_PROFILE : 'desktop';
	return path.join(home, 'profiles', profile);
}

/**
 * @param directory - profile directory.
 * @returns the absolute state file path.
 */
export function statePath(directory) {
	return path.join(directory, FILENAME);
}

/**
 * Read the persisted overrides.
 *
 * A missing, unreadable, or malformed file is an empty override set: a proxy
 * plugin that refuses to start because of its own state file would be worse
 * than one that starts on defaults.
 *
 * @param directory - profile directory.
 * @returns the stored fields, or `{}`.
 */
export function readState(directory) {
	try {
		const parsed = JSON.parse(fs.readFileSync(statePath(directory), 'utf8'));
		return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

/**
 * Replace the persisted overrides.
 *
 * @param directory - profile directory.
 * @param state - every field to keep.
 * @returns the file path written.
 * @throws when the profile directory is not writable; the caller reports it.
 */
export function writeState(directory, state) {
	fs.mkdirSync(directory, { recursive: true });
	const file = statePath(directory);
	fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
	return file;
}
