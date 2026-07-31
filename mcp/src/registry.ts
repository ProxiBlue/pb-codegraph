// Registry loader: JSON file mapping repo name -> { db_path, description }.
// Path comes from PB_CODEGRAPH_REGISTRY (no default absolute host path is
// ever baked in here — see .claude/plans/v0-2-0-codegraph-engine/005-mcp-shim-skeleton.md
// context note I4: db_path entries are CONTAINER-visible paths, resolved by
// whoever writes the registry, not by this loader).
import fs from 'node:fs';

export const PB_CODEGRAPH_REGISTRY_ENV = 'PB_CODEGRAPH_REGISTRY';

export interface RegistryEntry {
  db_path: string;
  description?: string;
}

export type Registry = Record<string, RegistryEntry>;

export function loadRegistryFromPath(registryPath: string): Registry {
  if (!fs.existsSync(registryPath)) {
    throw new Error(
      `pb-codegraph: registry file not found at "${registryPath}" (set via ${PB_CODEGRAPH_REGISTRY_ENV}). ` +
        'Create a JSON file mapping repo names to {db_path, description}.',
    );
  }

  let raw: string;
  try {
    raw = fs.readFileSync(registryPath, 'utf-8');
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`pb-codegraph: unable to read registry file at "${registryPath}": ${reason}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`pb-codegraph: registry file at "${registryPath}" is not valid JSON: ${reason}`);
  }

  return validateRegistryShape(parsed, registryPath);
}

export function loadRegistryFromEnv(env: NodeJS.ProcessEnv = process.env): Registry {
  const registryPath = env[PB_CODEGRAPH_REGISTRY_ENV];
  if (!registryPath) {
    throw new Error(
      `pb-codegraph: ${PB_CODEGRAPH_REGISTRY_ENV} is not set. ` +
        'Point it at a JSON registry file mapping repo names to {db_path, description} ' +
        '(container-visible paths; see docs/edge-taxonomy.md context and task 005 notes).',
    );
  }
  return loadRegistryFromPath(registryPath);
}

function validateRegistryShape(parsed: unknown, registryPath: string): Registry {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `pb-codegraph: registry file at "${registryPath}" must be a JSON object mapping repo name -> {db_path, description}`,
    );
  }

  const registry: Registry = {};
  for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (
      typeof value !== 'object' ||
      value === null ||
      typeof (value as { db_path?: unknown }).db_path !== 'string' ||
      (value as { db_path: string }).db_path.length === 0
    ) {
      throw new Error(
        `pb-codegraph: registry entry "${name}" in "${registryPath}" must include a non-empty string "db_path"`,
      );
    }

    const entry = value as { db_path: string; description?: unknown };
    registry[name] = {
      db_path: entry.db_path,
      ...(typeof entry.description === 'string' ? { description: entry.description } : {}),
    };
  }

  return registry;
}
